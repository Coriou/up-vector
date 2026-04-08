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

const UpdateBody = z.object({
	id: idSchema,
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

// Single atomic update for an existing vector. Handles vector / data / OVERWRITE
// metadata writes AND optional PATCH-merge of metadata in one Redis-atomic step
// so a concurrent DELETE between phases can't (a) leave a half-formed hash or
// (b) silently lose the PATCH while reporting `updated: 1`.
//
// Layout:
//   KEYS[1]   = vector key
//   ARGV[1]   = "1" if metadata PATCH is requested, "0" otherwise
//   ARGV[2]   = JSON-encoded patch (only meaningful when ARGV[1] == "1",
//               otherwise the empty string)
//   ARGV[3..] = alternating field/value pairs for the direct HSET
//               (vector / data / OVERWRITE metadata)
//
// Returns 1 if the vector existed and was updated, 0 otherwise.
const ATOMIC_UPDATE_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
local patch_mode = ARGV[1]
local patch_json = ARGV[2]
local has_pairs = #ARGV > 2
if has_pairs then
  local pairs_args = {}
  for i = 3, #ARGV do
    pairs_args[#pairs_args + 1] = ARGV[i]
  end
  redis.call('HSET', KEYS[1], unpack(pairs_args))
end
if patch_mode == '1' then
  local existing = redis.call('HGET', KEYS[1], 'metadata')
  local merged = patch_json
  if existing then
    local ok, base = pcall(cjson.decode, existing)
    if ok and type(base) == 'table' then
      local patch = cjson.decode(patch_json)
      for k, v in pairs(patch) do base[k] = v end
      merged = cjson.encode(base)
    end
  end
  redis.call('HSET', KEYS[1], 'metadata', merged)
end
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

	// Build the alternating field/value pairs for the direct HSET. Vec uses the
	// binary encoder — we cannot use redis.hset() here because Bun.redis
	// UTF-8-encodes Buffer values, corrupting the binary blob RediSearch indexes.
	const pairs: (string | Buffer)[] = []
	if (parsed.vector) {
		pairs.push("vec", encodeVector(parsed.vector))
		pairs.push("_vec", encodeVectorBase64(parsed.vector))
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

	const evalArgs: (string | Buffer)[] = [
		ATOMIC_UPDATE_LUA,
		"1",
		key,
		isPatch ? "1" : "0",
		isPatch ? JSON.stringify(parsed.metadata) : "",
		...pairs,
	]

	const result = (await redis.send("EVAL", evalArgs as string[])) as number
	return c.json({ result: { updated: result === 1 ? 1 : 0 } })
})
