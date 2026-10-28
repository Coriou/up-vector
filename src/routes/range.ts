import type { RedisClient } from "bun"
import { type Context, Hono } from "hono"
import { z } from "zod"
import { ValidationError } from "../errors"
import { reserveReadProjection } from "../read-budget"
import { getClient } from "../redis"
import {
	escapeGlobMeta,
	MAX_SCAN_ITERATIONS,
	parseVectorKey,
	validateNamespace,
	validatePrefix,
	vectorPrefix,
} from "../translate/keys"
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

/**
 * Scans every key matching `pattern`, deduplicating SCAN results. Throws a
 * ValidationError when the scan-iteration cap is exhausted before Redis
 * returns cursor "0", so oversized namespaces fail loudly instead of
 * presenting a truncated enumeration as complete.
 */
export async function collectScanKeys(
	redis: RedisClient,
	pattern: string,
	maxIterations: number = MAX_SCAN_ITERATIONS,
): Promise<Set<string>> {
	let scanCursor = "0"
	const collectedKeys = new Set<string>()
	let iterations = 0

	do {
		if (++iterations > maxIterations) {
			throw new ValidationError(
				`Namespace exceeds the scanable key limit (${maxIterations} SCAN iterations); range enumeration aborted`,
			)
		}
		const result = await redis.scan(scanCursor, "MATCH", pattern, "COUNT", 100)
		const [next, keys] = result as unknown as [string, string[]]

		// SCAN can return duplicate keys across iterations — Set.add dedupes.
		for (const key of keys) collectedKeys.add(key)

		scanCursor = next
	} while (scanCursor !== "0")

	return collectedKeys
}

export const rangeRoutes = new Hono()

const handleRange = async (c: Context) => {
	const body = await c.req.json()
	const parsed = RangeBody.parse(body)
	const ns = c.req.param("namespace") ?? ""
	validateNamespace(ns)
	const redis = getClient()

	if (parsed.prefix) validatePrefix(parsed.prefix)
	const basePrefix = vectorPrefix(ns)
	const pattern = parsed.prefix
		? `${basePrefix}${escapeGlobMeta(parsed.prefix)}*`
		: `${basePrefix}*`

	// Upstash's public cursor is an offset string ("0", "100", ...), not a
	// Redis SCAN cursor. Scan the namespace, sort for stable paging, then slice by
	// offset so the endpoint never returns more than `limit`.
	const offset = parsed.cursor === "" ? 0 : Number(parsed.cursor)
	const collectedKeys = await collectScanKeys(redis, pattern)

	const pageKeys = Array.from(collectedKeys)
		.sort()
		.slice(offset, offset + parsed.limit)

	reserveReadProjection(pageKeys.length, parsed)

	// Fetch details for each matched key
	const vectors: Vector[] = await Promise.all(
		pageKeys.map(async (key) => {
			const id = parseVectorKey(key)?.id ?? key
			const vec: Vector = { id }
			// Project only the fields the response flags need (HMGET) — the raw
			// `vec` blob and unrequested metadata/data previously rode along on
			// every page. (deep audit 2026-09-06, F8)
			const fields = [
				...(parsed.includeVectors ? ["_vec"] : []),
				...(parsed.includeMetadata ? ["metadata"] : []),
				...(parsed.includeData ? ["data"] : []),
			]
			if (fields.length === 0) {
				return vec
			}
			const values = (await redis.hmget(key, ...fields)) as (string | null)[]
			const hash: Record<string, string> = {}
			fields.forEach((field, i) => {
				const value = values[i]
				if (value !== null && value !== undefined) hash[field] = value
			})
			if (parsed.includeVectors && hash._vec) {
				vec.vector = decodeVectorBase64(hash._vec)
			}
			if (parsed.includeMetadata && hash.metadata) {
				try {
					vec.metadata = JSON.parse(hash.metadata)
				} catch {
					// Malformed metadata JSON — skip
				}
			}
			if (parsed.includeData && hash.data !== undefined) {
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
