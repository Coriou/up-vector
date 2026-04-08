import { Hono } from "hono"
import { z } from "zod"
import { config } from "../config"
import { ValidationError } from "../errors"
import type { FilterNode } from "../filter"
import { compileFilter, evaluate } from "../filter"
import { getClient } from "../redis"
import { loadDimension } from "../translate/index"
import { indexName, parseVectorKey, validateNamespace } from "../translate/keys"
import { normalizeScore } from "../translate/scores"
import { decodeVectorBase64, encodeVector } from "../translate/vectors"
import type { QueryResult } from "../types"

const OVER_FETCH_FACTOR = 3
const MAX_OVER_FETCH = 1000

const MAX_TOP_K = 1000
const MAX_VECTOR_DIM = 16384
const MAX_BATCH_QUERIES = 100

const finiteNumber = z.number().refine((n) => Number.isFinite(n), {
	message: "Vector values must be finite numbers (no NaN or Infinity)",
})

const SingleQuery = z.object({
	vector: z
		.array(finiteNumber)
		.min(1, "Vector dimension must be at least 1")
		.max(MAX_VECTOR_DIM, `Vector dimension must not exceed ${MAX_VECTOR_DIM}`),
	topK: z.number().int().positive().max(MAX_TOP_K).default(10),
	includeMetadata: z.boolean().default(false),
	includeVectors: z.boolean().default(false),
	includeData: z.boolean().default(false),
	filter: z.string().optional(),
})

const QueryBody = z.union([
	SingleQuery,
	z
		.array(SingleQuery)
		.min(1, "Batch must contain at least one query")
		.max(MAX_BATCH_QUERIES, `Batch must not exceed ${MAX_BATCH_QUERIES} queries`),
])

export const queryRoutes = new Hono()

queryRoutes.post("/query/:namespace?", async (c) => {
	const body = await c.req.json()
	const parsed = QueryBody.parse(body)
	const ns = c.req.param("namespace") ?? ""
	validateNamespace(ns)

	const isBatch = Array.isArray(parsed)
	const queries = isBatch ? parsed : [parsed]

	const results = await Promise.all(queries.map((q) => executeQuery(ns, q)))

	if (isBatch) {
		// SDK expects { result: [[...q1Results], [...q2Results]] } for batch queries.
		// The SDK's Command.exec() destructures body.result — an array of arrays.
		return c.json({ result: results })
	}
	return c.json({ result: results[0] })
})

type ParsedQuery = z.infer<typeof SingleQuery>

async function executeQuery(ns: string, query: ParsedQuery): Promise<QueryResult[]> {
	const redis = getClient()
	const idx = indexName(ns)

	// Validate dimension. loadDimension() falls back to FT.INFO when not cached so
	// we still catch dimension mismatches after a restart that left the cache cold.
	const existingDim = await loadDimension(ns)
	if (existingDim !== undefined && query.vector.length !== existingDim) {
		throw new ValidationError(
			`Dimension mismatch: namespace expects ${existingDim}, got ${query.vector.length}`,
		)
	}

	// Parse filter once for all candidates. compileFilter() also LRU-caches across
	// requests so identical filter strings reuse the same AST.
	let filterAst: FilterNode | undefined
	if (query.filter) {
		filterAst = compileFilter(query.filter)
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
		// No index = no vectors to search. RediSearch error wording has shifted
		// across versions; match case-insensitively on the substrings we know about.
		if (isMissingIndexError(msg)) {
			return []
		}
		throw err
	}

	// Parse FT.SEARCH response. We only need to JSON.parse the metadata when the
	// caller actually uses it (filter or includeMetadata) — skip the work otherwise.
	const needsMetadata = filterAst !== undefined || query.includeMetadata
	const candidates = parseFtSearchResponse(searchResult, needsMetadata)

	// Apply filter + normalize scores + trim to topK.
	// A vector with no metadata still needs to be evaluated against the filter:
	// e.g. `HAS NOT FIELD x` should *match* a vector with no metadata at all.
	// Pass an empty object so the evaluator gets a stable shape.
	const results: QueryResult[] = []
	for (const candidate of candidates) {
		if (filterAst) {
			try {
				if (!evaluate(filterAst, candidate.metadata ?? {})) continue
			} catch {
				continue // Filter eval threw on this candidate — skip defensively
			}
		}

		const result: QueryResult = {
			id: candidate.id,
			score: Number.isFinite(candidate.rawScore)
				? normalizeScore(candidate.rawScore, config.metric)
				: 0,
		}
		if (query.includeMetadata && candidate.metadata) {
			result.metadata = candidate.metadata
		}
		if (query.includeVectors && candidate.vecBase64) {
			result.vector = decodeVectorBase64(candidate.vecBase64)
		}
		if (query.includeData && candidate.data !== undefined) {
			result.data = candidate.data
		}

		results.push(result)
		if (results.length >= query.topK) break
	}

	return results
}

function isMissingIndexError(msg: string): boolean {
	const lower = msg.toLowerCase()
	return (
		lower.includes("unknown index") ||
		lower.includes("no such index") ||
		lower.includes("index does not exist") ||
		lower.includes("index not found")
	)
}

type Candidate = {
	id: string
	rawScore: number
	metadata?: Record<string, unknown>
	vecBase64?: string
	data?: string
}

// biome-ignore lint/suspicious/noExplicitAny: FT.SEARCH response shape varies by RESP version
function parseFtSearchResponse(response: any, parseMetadata: boolean): Candidate[] {
	// RESP3 object format (Bun.redis default)
	if (response && typeof response === "object" && !Array.isArray(response) && response.results) {
		return (response.results as Array<Record<string, unknown>>).map((result) => {
			const attrs = result.extra_attributes as Record<string, string> | undefined
			const redisKey = result.id as string
			const parsed = parseVectorKey(redisKey)
			let metadata: Record<string, unknown> | undefined
			if (parseMetadata && attrs?.metadata) {
				try {
					metadata = JSON.parse(attrs.metadata)
				} catch {
					// Malformed metadata JSON — skip
				}
			}
			return {
				id: parsed?.id ?? (attrs?.id as string) ?? redisKey,
				rawScore: Number(attrs?._score ?? 0),
				metadata,
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
			let metadata: Record<string, unknown> | undefined
			if (parseMetadata && attrs.metadata) {
				try {
					metadata = JSON.parse(attrs.metadata)
				} catch {
					// Malformed metadata JSON — skip
				}
			}
			candidates.push({
				id: parsed?.id ?? attrs.id ?? redisKey,
				rawScore: Number(attrs._score ?? 0),
				metadata,
				vecBase64: attrs._vec,
				data: attrs.data,
			})
		}
		return candidates
	}

	return []
}
