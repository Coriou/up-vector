import { type Context, Hono } from "hono"
import { z } from "zod"
import { getClient } from "../redis"
import { parseVectorKey, validateNamespace, validatePrefix, vectorPrefix } from "../translate/keys"
import { decodeVectorBase64 } from "../translate/vectors"
import type { Vector } from "../types"

const RangeBody = z.object({
	cursor: z
		.union([z.string(), z.number()])
		.transform(String)
		.refine((s) => s === "" || s === "0" || /^[1-9]\d*$/.test(s), {
			message: "Cursor must be a non-negative integer or empty string",
		}),
	limit: z.number().int().positive().max(1000),
	prefix: z.string().optional(),
	includeMetadata: z.boolean().default(false),
	includeVectors: z.boolean().default(false),
	includeData: z.boolean().default(false),
})

const MAX_SCAN_ITERATIONS = 10_000

export const rangeRoutes = new Hono()

const handleRange = async (c: Context) => {
	const body = await c.req.json()
	const parsed = RangeBody.parse(body)
	const ns = c.req.param("namespace") ?? ""
	validateNamespace(ns)
	const redis = getClient()

	if (parsed.prefix) validatePrefix(parsed.prefix)
	const basePrefix = vectorPrefix(ns)
	const pattern = parsed.prefix ? `${basePrefix}${parsed.prefix}*` : `${basePrefix}*`

	// Upstash's public cursor is an offset string ("0", "100", ...), not a
	// Redis SCAN cursor. Scan the namespace, sort for stable paging, then slice by
	// offset so the endpoint never returns more than `limit`.
	const offset = parsed.cursor === "" ? 0 : Number(parsed.cursor)
	let scanCursor = "0"
	const collectedKeys = new Set<string>()
	const seenKeys = new Set<string>()
	let iterations = 0

	do {
		if (++iterations > MAX_SCAN_ITERATIONS) break
		const result = await redis.scan(scanCursor, "MATCH", pattern, "COUNT", 100)
		const [next, keys] = result as unknown as [string, string[]]

		for (const key of keys) {
			// SCAN can return duplicate keys across iterations — deduplicate
			if (seenKeys.has(key)) continue
			seenKeys.add(key)
			collectedKeys.add(key)
		}

		scanCursor = next
	} while (scanCursor !== "0")

	const pageKeys = Array.from(collectedKeys)
		.sort()
		.slice(offset, offset + parsed.limit)

	// Fetch details for each matched key
	const vectors: Vector[] = await Promise.all(
		pageKeys.map(async (key) => {
			const hash = await redis.hgetall(key)
			const parsedKey = parseVectorKey(key)
			const id = parsedKey?.id ?? hash?.id ?? key

			const vec: Vector = { id }
			if (parsed.includeVectors && hash?._vec) {
				vec.vector = decodeVectorBase64(hash._vec)
			}
			if (parsed.includeMetadata && hash?.metadata) {
				try {
					vec.metadata = JSON.parse(hash.metadata)
				} catch {
					// Malformed metadata JSON — skip
				}
			}
			if (parsed.includeData && hash?.data !== undefined) {
				vec.data = hash.data
			}
			return vec
		}),
	)

	const nextOffset = offset + pageKeys.length
	const nextCursor = nextOffset >= collectedKeys.size ? "" : String(nextOffset)

	return c.json({ result: { nextCursor, vectors } })
}

rangeRoutes.get("/range/:namespace?", handleRange)
rangeRoutes.post("/range/:namespace?", handleRange)
