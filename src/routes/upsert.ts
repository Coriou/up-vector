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
const UnsupportedField = z.never().optional()

const VectorSchema = z.object({
	id: idSchema,
	vector: z
		.array(finiteNumber)
		.min(1, "Vector dimension must be at least 1")
		.max(MAX_VECTOR_DIM, `Vector dimension must not exceed ${MAX_VECTOR_DIM}`),
	sparseVector: UnsupportedField,
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

// Upsert is a replacement operation for the vector row. Optional fields that
// are omitted from a later upsert should not leave stale metadata/data behind.
const UPSERT_DENSE_LUA = `
redis.call('HSET', KEYS[1],
  'id', ARGV[1],
  'vec', ARGV[2],
  '_vec', ARGV[3]
)
if ARGV[4] == '1' then
  redis.call('HSET', KEYS[1], 'metadata', ARGV[5])
else
  redis.call('HDEL', KEYS[1], 'metadata')
end
if ARGV[6] == '1' then
  redis.call('HSET', KEYS[1], 'data', ARGV[7])
else
  redis.call('HDEL', KEYS[1], 'data')
end
return 1
`

upsertRoutes.post("/upsert/:namespace?", async (c) => {
	const body = await c.req.json()
	const parsed = UpsertBody.parse(body)
	const vectors = Array.isArray(parsed) ? parsed : [parsed]

	const ns = c.req.param("namespace") ?? ""
	await upsertDenseVectors(ns, vectors)

	return c.json({ result: "Success" })
})

export type DenseVectorInput = z.infer<typeof VectorSchema>

export async function upsertDenseVectors(ns: string, vectors: DenseVectorInput[]): Promise<void> {
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
	// SADD runs alongside the atomic upserts — both are independent and safe to
	// pipeline. The Lua path is used instead of HSET + HDEL so replacement
	// semantics do not expose stale metadata/data between commands. It also
	// preserves the binary vec blob; redis.hset() would UTF-8 encode Buffers.
	const writes: Promise<unknown>[] = vectors.map((v) => {
		const key = vectorKey(ns, v.id)
		const args: (string | Buffer)[] = [
			UPSERT_DENSE_LUA,
			"1",
			key,
			v.id,
			encodeVector(v.vector),
			encodeVectorBase64(v.vector),
			v.metadata !== undefined ? "1" : "0",
			v.metadata !== undefined ? JSON.stringify(v.metadata) : "",
			v.data !== undefined ? "1" : "0",
			v.data ?? "",
		]
		return redis.send("EVAL", args as string[])
	})
	writes.push(redis.sadd(NS_REGISTRY, ns))
	await Promise.all(writes)
}
