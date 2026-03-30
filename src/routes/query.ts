import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import { config } from "../config"
import { evaluateFilter } from "../filter"
import { getClient } from "../redis"
import { getDetectedDimension } from "../translate/index"
import { indexName, parseVectorKey } from "../translate/keys"
import { normalizeScore } from "../translate/scores"
import { decodeVectorBase64, encodeVector } from "../translate/vectors"
import type { QueryResult } from "../types"

const OVER_FETCH_FACTOR = 3
const MAX_OVER_FETCH = 1000

const SingleQuery = z.object({
	vector: z.array(z.number()),
	topK: z.number().int().positive().default(10),
	includeMetadata: z.boolean().default(false),
	includeVectors: z.boolean().default(false),
	includeData: z.boolean().default(false),
	filter: z.string().optional(),
})

const QueryBody = z.union([SingleQuery, z.array(SingleQuery)])

export const queryRoutes = new Hono()

queryRoutes.post("/query/:namespace?", async (c) => {
	const body = await c.req.json()
	const parsed = QueryBody.parse(body)
	const ns = c.req.param("namespace") ?? ""

	const isBatch = Array.isArray(parsed)
	const queries = isBatch ? parsed : [parsed]

	const results = await Promise.all(queries.map((q) => executeQuery(ns, q)))

	if (isBatch) {
		return c.json(results.map((r) => ({ result: r })))
	}
	return c.json({ result: results[0] })
})

type ParsedQuery = z.infer<typeof SingleQuery>

async function executeQuery(ns: string, query: ParsedQuery): Promise<QueryResult[]> {
	const redis = getClient()
	const idx = indexName(ns)

	// Validate dimension
	const existingDim = getDetectedDimension(ns)
	if (existingDim !== undefined && query.vector.length !== existingDim) {
		throw new HTTPException(400, {
			message: `Dimension mismatch: namespace expects ${existingDim}, got ${query.vector.length}`,
		})
	}

	// Calculate fetch count (over-fetch when filtering)
	const fetchCount = query.filter
		? Math.min(query.topK * OVER_FETCH_FACTOR, MAX_OVER_FETCH)
		: query.topK

	// Build FT.SEARCH KNN command
	const queryVec = encodeVector(query.vector)
	const args: (string | Buffer)[] = [
		idx,
		`*=>[KNN ${fetchCount} @vec $BLOB AS _score]`,
		"PARAMS",
		"2",
		"BLOB",
		queryVec,
		"SORTBY",
		"_score",
		"ASC",
		"LIMIT",
		"0",
		String(fetchCount),
		"DIALECT",
		"2",
	]

	let searchResult: unknown
	try {
		searchResult = await redis.send("FT.SEARCH", args as string[])
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err)
		// No index = no vectors to search
		if (
			msg.includes("Unknown index") ||
			msg.includes("Unknown Index") ||
			msg.includes("No such index")
		) {
			return []
		}
		throw err
	}

	// Parse FT.SEARCH response (RESP3 format)
	const candidates = parseFtSearchResponse(searchResult)

	// Apply filter + normalize scores + trim to topK
	const results: QueryResult[] = []
	for (const candidate of candidates) {
		// Apply metadata filter
		if (query.filter && candidate.metadata) {
			try {
				if (!evaluateFilter(query.filter, candidate.metadata)) continue
			} catch {
				continue // Malformed metadata or filter mismatch — skip
			}
		} else if (query.filter && !candidate.metadata) {
			continue // No metadata to filter against
		}

		const result: QueryResult = {
			id: candidate.id,
			score: normalizeScore(candidate.rawScore, config.metric),
		}
		if (query.includeMetadata && candidate.metadata) {
			result.metadata = candidate.metadata
		}
		if (query.includeVectors && candidate.vecBase64) {
			result.vector = decodeVectorBase64(candidate.vecBase64)
		}
		if (query.includeData && candidate.data) {
			result.data = candidate.data
		}

		results.push(result)
		if (results.length >= query.topK) break
	}

	return results
}

type Candidate = {
	id: string
	rawScore: number
	metadata?: Record<string, unknown>
	vecBase64?: string
	data?: string
}

// biome-ignore lint/suspicious/noExplicitAny: FT.SEARCH response shape varies by RESP version
function parseFtSearchResponse(response: any): Candidate[] {
	// RESP3 object format (Bun.redis default)
	if (response && typeof response === "object" && !Array.isArray(response) && response.results) {
		return (response.results as Array<Record<string, unknown>>).map((result) => {
			const attrs = result.extra_attributes as Record<string, string> | undefined
			const redisKey = result.id as string
			const parsed = parseVectorKey(redisKey)
			return {
				id: parsed?.id ?? (attrs?.id as string) ?? redisKey,
				rawScore: Number(attrs?._score ?? 0),
				metadata: attrs?.metadata ? JSON.parse(attrs.metadata) : undefined,
				vecBase64: attrs?._vec as string | undefined,
				data: attrs?.data as string | undefined,
			}
		})
	}

	// RESP2 flat array fallback: [total, key1, [field, val, ...], key2, ...]
	if (Array.isArray(response)) {
		const candidates: Candidate[] = []
		for (let i = 1; i < response.length; i += 2) {
			const redisKey = response[i] as string
			const fields = response[i + 1] as string[]
			const attrs: Record<string, string> = {}
			for (let j = 0; j < fields.length; j += 2) {
				attrs[fields[j]] = fields[j + 1]
			}
			const parsed = parseVectorKey(redisKey)
			candidates.push({
				id: parsed?.id ?? attrs.id ?? redisKey,
				rawScore: Number(attrs._score ?? 0),
				metadata: attrs.metadata ? JSON.parse(attrs.metadata) : undefined,
				vecBase64: attrs._vec,
				data: attrs.data,
			})
		}
		return candidates
	}

	return []
}
