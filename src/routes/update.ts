import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import { config } from "../config"
import { getEmbeddingProvider } from "../embedding"
import { EmbeddingProviderError, ValidationError } from "../errors"
import { mergePatch } from "../merge-patch"
import { getClient } from "../redis"
import { loadDimension } from "../translate/index"
import { EMBEDDING_NS_REGISTRY, validateId, validateNamespace, vectorKey } from "../translate/keys"
import { encodeVector, encodeVectorBase64, finiteNumber } from "../translate/vectors"
import { MAX_DATA_LENGTH, MAX_METADATA_BYTES } from "./upsert"

// Numeric IDs that aren't finite would silently become "NaN" / "Infinity"
// strings after the .transform(String) below — reject them up front so users
// get a clear validation error instead of a magic string ID.
const idSchema = z
	.union([
		z.string(),
		z.number().refine((n) => Number.isFinite(n), "Vector ID must be a finite number"),
	])
	.transform(String)

const MAX_VECTOR_DIM = 16384
const UnsupportedField = z.never().optional()

const UpdateBody = z.object({
	id: idSchema,
	vector: z
		.array(finiteNumber)
		.min(1, "Vector dimension must be at least 1")
		.max(MAX_VECTOR_DIM, `Vector dimension must not exceed ${MAX_VECTOR_DIM}`)
		.optional(),
	sparseVector: UnsupportedField,
	// Same budgets as /upsert (VectorSchema) — an /update write bypassing the
	// cap let a single request persist ~32MiB of metadata/data that every
	// includeMetadata/includeData read then retransfers.
	// (deep audit 2026-09-06, F4)
	metadata: z
		.record(z.string(), z.unknown())
		.optional()
		.refine(
			(m) => m === undefined || Buffer.byteLength(JSON.stringify(m), "utf8") <= MAX_METADATA_BYTES,
			`Serialized metadata must not exceed ${MAX_METADATA_BYTES} bytes`,
		),
	data: z
		.string()
		.max(MAX_DATA_LENGTH, `Data must not exceed ${MAX_DATA_LENGTH} characters`)
		.optional(),
	metadataUpdateMode: z.enum(["OVERWRITE", "PATCH"]).default("OVERWRITE"),
})

export const updateRoutes = new Hono()

// PATCH is merged in JS to preserve JSON types and double precision. Lua
// compares the exact metadata snapshot before atomically writing ALL fields.
// -2 means a concurrent writer changed metadata; retry from a fresh snapshot.
// EXISTS still prevents resurrecting a concurrently deleted vector.
const ATOMIC_UPDATE_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
if ARGV[1] == '1' then
  local existing = redis.call('HGET', KEYS[1], 'metadata')
  if (existing or '') ~= ARGV[2] then
    return -2
  end
end
local pairs_args = {}
for i = 3, #ARGV do
  pairs_args[#pairs_args + 1] = ARGV[i]
end
redis.call('HSET', KEYS[1], unpack(pairs_args))
return 1
`

updateRoutes.post("/update/:namespace?", async (c) => {
	const body = await c.req.json()
	const parsed = UpdateBody.parse(body)
	const ns = c.req.param("namespace") ?? ""
	validateNamespace(ns)
	validateId(parsed.id)
	const redis = getClient()
	const key = vectorKey(ns, parsed.id)
	const shouldEmbedData =
		parsed.vector === undefined &&
		parsed.data !== undefined &&
		config.embeddingProvider !== "disabled" &&
		(await redis.sismember(EMBEDDING_NS_REGISTRY, ns))
	const vector =
		parsed.vector ?? (shouldEmbedData ? await embedUpdatedData(parsed.data) : undefined)

	// Validate vector dimension up front (Zod already enforces dim >= 1).
	// We have to do this *before* the Lua call because the dimension cache lives
	// in the application — Lua can't reach it.
	if (vector) {
		const existingDim = await loadDimension(ns)
		if (existingDim !== undefined && vector.length !== existingDim) {
			throw new ValidationError(
				`Dimension mismatch: namespace expects ${existingDim}, got ${vector.length}`,
			)
		}
	}

	// Build the alternating field/value pairs for the direct HSET. Vec uses the
	// binary encoder — we cannot use redis.hset() here because Bun.redis
	// UTF-8-encodes Buffer values, corrupting the binary blob RediSearch indexes.
	const pairs: (string | Buffer)[] = []
	if (vector) {
		pairs.push("vec", encodeVector(vector))
		pairs.push("_vec", encodeVectorBase64(vector))
	}
	if (parsed.metadata !== undefined && parsed.metadataUpdateMode !== "PATCH") {
		pairs.push("metadata", JSON.stringify(parsed.metadata))
	}
	if (parsed.data !== undefined) {
		pairs.push("data", parsed.data)
	}

	const isPatch = parsed.metadata !== undefined && parsed.metadataUpdateMode === "PATCH"

	// No-op request — nothing to update. Return updated:0 (matches Upstash:
	// no field to write means no row to bump even if the key exists).
	if (pairs.length === 0 && !isPatch) {
		return c.json({ result: { updated: 0 } })
	}

	for (let attempt = 0; attempt < 8; attempt++) {
		let snapshot = ""
		const writes = [...pairs]
		if (isPatch) {
			snapshot = (await redis.hget(key, "metadata")) ?? ""
			let base: unknown = {}
			if (snapshot) {
				try {
					base = JSON.parse(snapshot)
				} catch {
					// Repair malformed externally written metadata from an empty base.
				}
			}
			const merged = JSON.stringify(mergePatch(base, parsed.metadata))
			if (Buffer.byteLength(merged, "utf8") > MAX_METADATA_BYTES) {
				throw new ValidationError(`Merged metadata must not exceed ${MAX_METADATA_BYTES} bytes`)
			}
			writes.push("metadata", merged)
		}
		const evalArgs: (string | Buffer)[] = [
			ATOMIC_UPDATE_LUA,
			"1",
			key,
			isPatch ? "1" : "0",
			snapshot,
			...writes,
		]
		const result = (await redis.send("EVAL", evalArgs as string[])) as number
		if (result === -2) continue
		return c.json({ result: { updated: result === 1 ? 1 : 0 } })
	}
	throw new HTTPException(409, { message: "Concurrent metadata update; retry the request" })
})

async function embedUpdatedData(data: string | undefined): Promise<number[] | undefined> {
	if (data === undefined) {
		return undefined
	}

	const embeddings = await getEmbeddingProvider().embedMany([data])
	if (embeddings.length !== 1) {
		throw new EmbeddingProviderError(
			`Embedding provider returned ${embeddings.length} embeddings for 1 input`,
			502,
		)
	}
	return embeddings[0]
}
