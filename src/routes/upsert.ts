import { Hono } from "hono"
import { z } from "zod"
import { ValidationError } from "../errors"
import { getClient } from "../redis"
import { ensureIndex, loadDimension, setDetectedDimension } from "../translate/index"
import { NS_REGISTRY, validateId, validateNamespace, vectorKey } from "../translate/keys"
import { encodeVector, encodeVectorBase64 } from "../translate/vectors"

const finiteNumber = z.number().refine((n) => Number.isFinite(n), {
	message: "Vector values must be finite numbers (no NaN or Infinity)",
})

// Numeric IDs that aren't finite would silently become "NaN" / "Infinity"
// strings after .transform(String) — reject them up front so users get a
// clear validation error instead of a magic string ID.
const idSchema = z
	.union([
		z.string(),
		z.number().refine((n) => Number.isFinite(n), "Vector ID must be a finite number"),
	])
	.transform(String)

const MAX_VECTOR_DIM = 16384

const VectorSchema = z.object({
	id: idSchema,
	vector: z
		.array(finiteNumber)
		.min(1, "Vector dimension must be at least 1")
		.max(MAX_VECTOR_DIM, `Vector dimension must not exceed ${MAX_VECTOR_DIM}`),
	metadata: z.record(z.string(), z.unknown()).optional(),
	data: z.string().optional(),
})

const MAX_BATCH_SIZE = 1000

const UpsertBody = z.union([
	VectorSchema,
	z
		.array(VectorSchema)
		.min(1, "Batch must contain at least one vector")
		.max(MAX_BATCH_SIZE, `Batch size must not exceed ${MAX_BATCH_SIZE}`),
])

export const upsertRoutes = new Hono()

upsertRoutes.post("/upsert/:namespace?", async (c) => {
	const body = await c.req.json()
	const parsed = UpsertBody.parse(body)
	const vectors = Array.isArray(parsed) ? parsed : [parsed]

	const ns = c.req.param("namespace") ?? ""
	validateNamespace(ns)
	const redis = getClient()

	// Validate dimension consistency within the batch (Zod already enforces dim >= 1)
	const dim = vectors[0].vector.length
	for (const v of vectors) {
		validateId(v.id)
		if (v.vector.length !== dim) {
			throw new ValidationError(
				`Dimension mismatch in batch: expected ${dim}, got ${v.vector.length}`,
			)
		}
	}

	// Validate against existing namespace dimension. loadDimension() consults the
	// in-memory cache first and falls back to FT.INFO so we still catch mismatches
	// after a server restart that didn't fully sync indexes.
	const existingDim = await loadDimension(ns)
	if (existingDim !== undefined && existingDim !== dim) {
		throw new ValidationError(`Dimension mismatch: namespace expects ${existingDim}, got ${dim}`)
	}

	// Ensure the RediSearch index exists. ensureIndex() also validates dimension
	// against what Redis reports, defending against the race where two requests
	// with different dimensions hit a freshly-restarted server simultaneously.
	// ensureIndex() throws ValidationError on dim mismatch — propagate as-is so
	// the global error handler maps it to 400.
	await ensureIndex(ns, dim)
	setDetectedDimension(ns, dim)

	// Upsert all vectors (auto-pipelined via Promise.all). The namespace registry
	// SADD runs alongside the HSETs — both are independent and safe to pipeline.
	// Must use send("HSET") instead of redis.hset() because hset() UTF-8 encodes
	// Buffer values, corrupting the binary vec blob that RediSearch needs.
	const writes: Promise<unknown>[] = vectors.map((v) => {
		const key = vectorKey(ns, v.id)
		const args: (string | Buffer)[] = [
			key,
			"id",
			v.id,
			"vec",
			encodeVector(v.vector),
			"_vec",
			encodeVectorBase64(v.vector),
		]
		if (v.metadata !== undefined) {
			args.push("metadata", JSON.stringify(v.metadata))
		}
		if (v.data !== undefined) {
			args.push("data", v.data)
		}
		return redis.send("HSET", args as string[])
	})
	writes.push(redis.sadd(NS_REGISTRY, ns))
	await Promise.all(writes)

	return c.json({ result: "Success" })
})
