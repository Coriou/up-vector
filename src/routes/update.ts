import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
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

// Atomic merge of new metadata into the existing metadata field on a hash. The
// in-Redis check-then-set protects against lost-update races between concurrent
// PATCH calls. Returns 1 if the key existed (and was updated), 0 otherwise.
const PATCH_METADATA_LUA = `
local existing = redis.call('HGET', KEYS[1], 'metadata')
if not existing and redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
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

	// Check if vector exists
	const exists = await redis.exists(key)
	if (!exists) {
		return c.json({ result: { updated: 0 } })
	}

	// Build HSET args — must use send("HSET") for binary vec field
	const args: (string | Buffer)[] = [key]

	// Update vector if provided (Zod already enforces dim >= 1)
	if (parsed.vector) {
		const existingDim = await loadDimension(ns)
		if (existingDim !== undefined && parsed.vector.length !== existingDim) {
			throw new HTTPException(400, {
				message: `Dimension mismatch: namespace expects ${existingDim}, got ${parsed.vector.length}`,
			})
		}
		args.push("vec", encodeVector(parsed.vector), "_vec", encodeVectorBase64(parsed.vector))
	}

	// Metadata in OVERWRITE mode is the trivial case — just stringify and HSET.
	// PATCH mode runs through a Lua script for atomic read-merge-write so two
	// concurrent PATCH calls can't lose updates between hget and hset.
	if (parsed.metadata !== undefined) {
		if (parsed.metadataUpdateMode === "PATCH") {
			await redis.send("EVAL", [PATCH_METADATA_LUA, "1", key, JSON.stringify(parsed.metadata)])
		} else {
			args.push("metadata", JSON.stringify(parsed.metadata))
		}
	}

	// Update data if provided
	if (parsed.data !== undefined) {
		args.push("data", parsed.data)
	}

	if (args.length > 1) {
		await redis.send("HSET", args as string[])
	}

	return c.json({ result: { updated: 1 } })
})
