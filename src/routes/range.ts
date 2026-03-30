import { Hono } from "hono"
import { z } from "zod"
import { getClient } from "../redis"
import { parseVectorKey, vectorPrefix } from "../translate/keys"
import { decodeVectorBase64 } from "../translate/vectors"
import type { Vector } from "../types"

const RangeBody = z.object({
	cursor: z.union([z.string(), z.number()]).transform(String),
	limit: z.number().int().positive(),
	prefix: z.string().optional(),
	includeMetadata: z.boolean().default(false),
	includeVectors: z.boolean().default(false),
	includeData: z.boolean().default(false),
})

export const rangeRoutes = new Hono()

rangeRoutes.post("/range/:namespace?", async (c) => {
	const body = await c.req.json()
	const parsed = RangeBody.parse(body)
	const ns = c.req.param("namespace") ?? ""
	const redis = getClient()

	const basePrefix = vectorPrefix(ns)
	const pattern = parsed.prefix ? `${basePrefix}${parsed.prefix}*` : `${basePrefix}*`

	// SCAN with the given cursor, COUNT = limit as a hint
	const scanCursor = parsed.cursor === "" ? 0 : Number(parsed.cursor)
	const result = await redis.scan(scanCursor, "MATCH", pattern, "COUNT", parsed.limit)
	const [rawCursor, keys] = result as unknown as [string, string[]]

	// Fetch details for each matched key
	const vectors: Vector[] = await Promise.all(
		keys.map(async (key) => {
			const hash = await redis.hgetall(key)
			const parsedKey = parseVectorKey(key)
			const id = parsedKey?.id ?? hash?.id ?? key

			const vec: Vector = { id }
			if (parsed.includeVectors && hash?._vec) {
				vec.vector = decodeVectorBase64(hash._vec)
			}
			if (parsed.includeMetadata && hash?.metadata) {
				vec.metadata = JSON.parse(hash.metadata)
			}
			if (parsed.includeData && hash?.data) {
				vec.data = hash.data
			}
			return vec
		}),
	)

	// Map Redis done-cursor ("0") to Upstash done-signal ("")
	const nextCursor = String(rawCursor) === "0" ? "" : String(rawCursor)

	return c.json({ result: { nextCursor, vectors } })
})
