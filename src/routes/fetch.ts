import { Hono } from "hono"
import { z } from "zod"
import { getClient } from "../redis"
import { parseVectorKey, validateNamespace, vectorKey, vectorPrefix } from "../translate/keys"
import { decodeVectorBase64 } from "../translate/vectors"
import type { Vector } from "../types"

const MAX_ID_LENGTH = 1024

const idSchema = z
	.union([z.string(), z.number()])
	.transform(String)
	.refine((s) => s.length > 0, "Vector ID must not be empty")
	.refine((s) => s.length <= MAX_ID_LENGTH, `Vector ID must not exceed ${MAX_ID_LENGTH} characters`)

const FetchBody = z.object({
	ids: z.array(idSchema).max(1000, "Batch must not exceed 1000 ids").optional(),
	prefix: z.string().optional(),
	includeMetadata: z.boolean().default(false),
	includeVectors: z.boolean().default(false),
	includeData: z.boolean().default(false),
})

export const fetchRoutes = new Hono()

fetchRoutes.post("/fetch/:namespace?", async (c) => {
	const body = await c.req.json()
	const parsed = FetchBody.parse(body)
	const ns = c.req.param("namespace") ?? ""
	validateNamespace(ns)
	const redis = getClient()

	// Fetch by IDs (default path, also used when both ids and prefix are given)
	if (parsed.ids) {
		const results = await Promise.all(
			parsed.ids.map(async (id): Promise<Vector | null> => {
				const hash = await redis.hgetall(vectorKey(ns, id))
				if (!hash || Object.keys(hash).length === 0) return null
				return buildVector(hash, id, parsed)
			}),
		)
		return c.json({ result: results })
	}

	// Fetch by prefix — Upstash caps at 1000 results for prefix fetch
	if (parsed.prefix) {
		const pattern = `${vectorPrefix(ns)}${parsed.prefix}*`
		const keys = await scanAll(redis, pattern, 1000)
		const results = await Promise.all(
			keys.map(async (key) => {
				const hash = await redis.hgetall(key)
				if (!hash || Object.keys(hash).length === 0) return null
				const parsed_key = parseVectorKey(key)
				return buildVector(hash, parsed_key?.id ?? hash.id, parsed)
			}),
		)
		return c.json({ result: results.filter(Boolean) })
	}

	// Neither ids nor prefix
	return c.json({ result: [] })
})

function buildVector(
	hash: Record<string, string>,
	id: string,
	opts: {
		includeVectors: boolean
		includeMetadata: boolean
		includeData: boolean
	},
): Vector {
	const vec: Vector = { id }
	if (opts.includeVectors && hash._vec) {
		vec.vector = decodeVectorBase64(hash._vec)
	}
	if (opts.includeMetadata && hash.metadata) {
		try {
			vec.metadata = JSON.parse(hash.metadata)
		} catch {
			// Malformed metadata JSON — skip
		}
	}
	if (opts.includeData && hash.data !== undefined) {
		vec.data = hash.data
	}
	return vec
}

const MAX_SCAN_ITERATIONS = 10_000

async function scanAll(
	redis: ReturnType<typeof getClient>,
	pattern: string,
	limit = Number.POSITIVE_INFINITY,
): Promise<string[]> {
	const keys = new Set<string>()
	let cursor = "0"
	let iterations = 0
	do {
		if (++iterations > MAX_SCAN_ITERATIONS) break
		const result = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100)
		const [next, batch] = result as unknown as [string, string[]]
		for (const key of batch) {
			keys.add(key)
			if (keys.size >= limit) break
		}
		cursor = next
		if (keys.size >= limit) break
	} while (cursor !== "0")
	return Array.from(keys)
}
