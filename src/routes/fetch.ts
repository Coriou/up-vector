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
	validateId,
	validateNamespace,
	validatePrefix,
	vectorKey,
	vectorPrefix,
} from "../translate/keys"
import { decodeVectorBase64 } from "../translate/vectors"
import type { Vector } from "../types"

const idSchema = z
	.union([
		z.string(),
		z.number().refine((n) => Number.isFinite(n), "Vector ID must be a finite number"),
	])
	.transform(String)

const FetchBody = z.object({
	ids: z.array(idSchema).max(1000, "Batch must not exceed 1000 ids").optional(),
	prefix: z.string().optional(),
	includeMetadata: z.boolean().default(false),
	includeVectors: z.boolean().default(false),
	includeData: z.boolean().default(false),
})

export const fetchRoutes = new Hono()

const handleFetch = async (c: Context) => {
	const body = await c.req.json()
	const parsed = FetchBody.parse(body)
	const ns = c.req.param("namespace") ?? ""
	validateNamespace(ns)
	if (parsed.ids) {
		// Read paths share the write-path ID contract (update.ts) — empty ids,
		// control characters, and over-length ids are rejected identically.
		for (const id of parsed.ids) validateId(id)
	}
	const redis = getClient()

	// Fetch by IDs (default path, also used when both ids and prefix are given)
	if (parsed.ids) {
		reserveReadProjection(parsed.ids.length, parsed)
		const results = await Promise.all(
			parsed.ids.map((id) => fetchVectorFields(redis, vectorKey(ns, id), parsed)),
		)
		return c.json({ result: results })
	}

	// Fetch by prefix — Upstash caps at 1000 results for prefix fetch
	if (parsed.prefix) {
		validatePrefix(parsed.prefix)
		const pattern = `${vectorPrefix(ns)}${escapeGlobMeta(parsed.prefix)}*`
		const keys = await scanAll(redis, pattern, 1000)
		reserveReadProjection(keys.length, parsed)
		const results = await Promise.all(keys.map((key) => fetchVectorFields(redis, key, parsed)))
		return c.json({ result: results.filter(Boolean) })
	}

	// Neither ids nor prefix
	return c.json({ result: [] })
}

fetchRoutes.get("/fetch/:namespace?", handleFetch)
fetchRoutes.post("/fetch/:namespace?", handleFetch)

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

// Read paths project only the fields the response flags need. The raw `vec`
// blob (RediSearch-only) and unrequested metadata/data previously rode along
// on every fetch — up to ~1.1GB transferred and discarded per 1000-id request
// at the per-field caps. (deep audit 2026-09-06, F8)
function requestedFields(opts: {
	includeVectors: boolean
	includeMetadata: boolean
	includeData: boolean
}): string[] {
	const fields: string[] = []
	if (opts.includeVectors) fields.push("_vec")
	if (opts.includeMetadata) fields.push("metadata")
	if (opts.includeData) fields.push("data")
	return fields
}
async function fetchVectorFields(
	redis: RedisClient,
	key: string,
	opts: {
		includeVectors: boolean
		includeMetadata: boolean
		includeData: boolean
	},
): Promise<Vector | null> {
	const fields = requestedFields(opts)
	const hash: Record<string, string> = {}
	if (fields.length > 0) {
		const values = (await redis.hmget(key, ...fields)) as (string | null)[]
		fields.forEach((field, i) => {
			const value = values[i]
			if (value !== null && value !== undefined) hash[field] = value
		})
	}
	if (Object.keys(hash).length === 0) {
		// SCAN is not a snapshot: a key may disappear before the projected read.
		// Distinguish an absent row from one with only unrequested fields.
		if (!(await redis.exists(key))) return null
	}
	return buildVector(hash, parseVectorKey(key)?.id ?? key, opts)
}

async function scanAll(
	redis: RedisClient,
	pattern: string,
	limit = Number.POSITIVE_INFINITY,
): Promise<string[]> {
	const keys = new Set<string>()
	let cursor = "0"
	let iterations = 0
	do {
		if (++iterations > MAX_SCAN_ITERATIONS) {
			// Loud like range.ts: a truncated prefix enumeration presented as
			// complete is a silent correctness bug. (deep audit 2026-09-06, F3)
			throw new ValidationError(
				`Keyspace exceeds the scanable key limit (${MAX_SCAN_ITERATIONS} SCAN iterations); prefix enumeration aborted`,
			)
		}
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
