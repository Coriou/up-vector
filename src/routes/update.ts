import { Hono } from "hono"
import { z } from "zod"
import { ValidationError } from "../errors"
import { getClient } from "../redis"
import { loadDimension } from "../translate/index"
import { validateId, validateNamespace, vectorKey } from "../translate/keys"
import { encodeVector, encodeVectorBase64 } from "../translate/vectors"

const finiteNumber = z.number().refine((n) => Number.isFinite(n), {
	message: "Vector values must be finite numbers (no NaN or Infinity)",
})

const MAX_VECTOR_DIM = 16384

const UpdateBody = z.object({
	id: z.union([z.string(), z.number()]).transform(String),
	vector: z
		.array(finiteNumber)
		.min(1, "Vector dimension must be at least 1")
		.max(MAX_VECTOR_DIM, `Vector dimension must not exceed ${MAX_VECTOR_DIM}`)
		.optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
	data: z.string().optional(),
	metadataUpdateMode: z.enum(["OVERWRITE", "PATCH"]).default("OVERWRITE"),
})

export const updateRoutes = new Hono()

// Atomic update of an existing vector. The previous implementation did
// `EXISTS key` followed by `HSET key …` from the application — between those
// two calls another request could DELETE the key, leaving HSET to recreate a
// half-formed hash with no `vec` field. This Lua script bundles the existence
// check and all field writes into a single Redis-atomic step.
//
// Field layout (KEYS=1 key, ARGV=alternating field/value pairs):
//   ARGV[i]   = field name
//   ARGV[i+1] = field value
//
// Returns 1 if the vector existed and was updated, 0 otherwise.
const ATOMIC_UPDATE_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
if #ARGV > 0 then
  redis.call('HSET', KEYS[1], unpack(ARGV))
end
return 1
`

// Atomic merge of new metadata into the existing metadata field on a hash. The
// in-Redis check-then-set protects against lost-update races between concurrent
// PATCH calls. Returns 1 if the key existed (and was updated), 0 otherwise.
const PATCH_METADATA_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
local existing = redis.call('HGET', KEYS[1], 'metadata')
local merged = ARGV[1]
if existing then
  local ok, base = pcall(cjson.decode, existing)
  if ok and type(base) == 'table' then
    local patch = cjson.decode(ARGV[1])
    for k, v in pairs(patch) do base[k] = v end
    merged = cjson.encode(base)
  end
end
redis.call('HSET', KEYS[1], 'metadata', merged)
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

	// Validate vector dimension up front (Zod already enforces dim >= 1).
	// We have to do this *before* the Lua call because the dimension cache lives
	// in the application — Lua can't reach it.
	if (parsed.vector) {
		const existingDim = await loadDimension(ns)
		if (existingDim !== undefined && parsed.vector.length !== existingDim) {
			throw new ValidationError(
				`Dimension mismatch: namespace expects ${existingDim}, got ${parsed.vector.length}`,
			)
		}
	}

	// Build the field/value pairs (excluding metadata, which goes through a
	// dedicated path for PATCH mode). Vec needs the binary encoder; we cannot
	// use redis.hset() here because Bun.redis UTF-8-encodes Buffer values.
	const args: (string | Buffer)[] = []
	if (parsed.vector) {
		args.push("vec", encodeVector(parsed.vector))
		args.push("_vec", encodeVectorBase64(parsed.vector))
	}
	if (parsed.metadata !== undefined && parsed.metadataUpdateMode !== "PATCH") {
		args.push("metadata", JSON.stringify(parsed.metadata))
	}
	if (parsed.data !== undefined) {
		args.push("data", parsed.data)
	}

	// Run the atomic vector/data/overwrite-metadata update first.
	let updated = 0
	if (args.length > 0) {
		const result = (await redis.send("EVAL", [
			ATOMIC_UPDATE_LUA,
			"1",
			key,
			...(args as string[]),
		])) as number
		if (result === 0) {
			return c.json({ result: { updated: 0 } })
		}
		updated = 1
	}

	// PATCH metadata runs through its own atomic Lua so two concurrent PATCH
	// calls can't lose updates between hget and hset.
	if (parsed.metadata !== undefined && parsed.metadataUpdateMode === "PATCH") {
		const result = (await redis.send("EVAL", [
			PATCH_METADATA_LUA,
			"1",
			key,
			JSON.stringify(parsed.metadata),
		])) as number
		if (result === 0 && updated === 0) {
			return c.json({ result: { updated: 0 } })
		}
		updated = 1
	}

	return c.json({ result: { updated } })
})
