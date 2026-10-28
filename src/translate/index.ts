import { config } from "../config"
import { ValidationError } from "../errors"
import { log } from "../logger"
import { getClient } from "../redis"
import { redisGeneration } from "../redis-generation"
import { indexName, NS_REGISTRY } from "./keys"
import { toRedisDistanceMetric } from "./scores"

const knownIndexes = new Set<string>()
const dimensionMap = new Map<string, number>()
// Per-index in-flight FT.CREATE — serializes concurrent first-upserts so we don't
// fire two FT.CREATE commands and rely on the "Index already exists" catch.
const pendingIndexCreations = new Map<string, Promise<void>>()

let cacheGeneration = redisGeneration()
function refreshCacheGeneration(): number {
	const generation = redisGeneration()
	if (cacheGeneration !== generation) {
		knownIndexes.clear()
		dimensionMap.clear()
		pendingIndexCreations.clear()
		cacheGeneration = generation
	}
	return generation
}

function cacheIndex(ns: string, dimension: number, generation: number): void {
	// An old client's in-flight command must not repopulate the new cache.
	if (refreshCacheGeneration() !== generation) return
	dimensionMap.set(ns, dimension)
	knownIndexes.add(indexName(ns))
}

export function getDetectedDimension(ns: string): number | undefined {
	refreshCacheGeneration()
	return config.dimension ?? dimensionMap.get(ns)
}

/**
 * Resolve the dimension for a namespace, querying Redis when not cached. This
 * exists for the case where syncIndexes() couldn't run (or failed) at startup
 * and a request hits a namespace whose dimension we don't know yet.
 */
export async function loadDimension(ns: string): Promise<number | undefined> {
	const generation = refreshCacheGeneration()
	if (config.dimension !== undefined) return config.dimension
	const cached = dimensionMap.get(ns)
	if (cached !== undefined) return cached

	const idx = indexName(ns)
	const redis = getClient()
	try {
		const info = await redis.send("FT.INFO", [idx])
		const dim = parseDimensionFromInfo(info)
		if (dim !== undefined) {
			// Metric is process-wide config; dimension is being discovered
			// here, so only metric compatibility is checkable at this boundary.
			validateIndexCompatibility(
				ns,
				dim,
				parseMetricFromInfo(info),
				config.dimension,
				toRedisDistanceMetric(config.metric),
			)
			cacheIndex(ns, dim, generation)
			return dim
		}
	} catch (err) {
		// Index does not exist yet — that's fine, the caller will create it.
		// Compatibility mismatches must surface instead of being swallowed.
		if (err instanceof ValidationError) throw err
	}
	return undefined
}

export async function ensureIndex(ns: string, dimension: number): Promise<void> {
	const generation = refreshCacheGeneration()
	const idx = indexName(ns)
	if (knownIndexes.has(idx)) {
		const cached = dimensionMap.get(ns)
		if (cached !== undefined && cached !== dimension) {
			throw new ValidationError(`Dimension mismatch: namespace expects ${cached}, got ${dimension}`)
		}
		return
	}

	// Coalesce concurrent first-upserts on the same namespace
	const pending = pendingIndexCreations.get(idx)
	if (pending) {
		await pending
		// Reconnect can discard the creator's cache write. Re-enter validation
		// so a missing cache never authorizes a different-dimensional writer.
		return ensureIndex(ns, dimension)
	}

	const promise = createIndexInternal(ns, dimension, idx)
	pendingIndexCreations.set(idx, promise)
	try {
		await promise
	} finally {
		if (pendingIndexCreations.get(idx) === promise) pendingIndexCreations.delete(idx)
	}
	// The creating request also needs validation against the current connection,
	// even though its old completion was correctly prevented from caching.
	if (refreshCacheGeneration() !== generation) return ensureIndex(ns, dimension)
}

async function createIndexInternal(ns: string, dimension: number, idx: string): Promise<void> {
	const generation = refreshCacheGeneration()
	const redis = getClient()
	const prefix = `v:${ns}:`

	try {
		await redis.send("FT.CREATE", [
			idx,
			"ON",
			"HASH",
			"PREFIX",
			"1",
			prefix,
			"SCHEMA",
			"vec",
			"VECTOR",
			"HNSW",
			"6",
			"TYPE",
			"FLOAT32",
			"DIM",
			String(dimension),
			"DISTANCE_METRIC",
			toRedisDistanceMetric(config.metric),
		])
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err)
		// Index exists from a previous run — query its actual dimension and
		// distance metric and fail loudly if they don't match the configured
		// values. Without the metric check, restarting with a different
		// UPVECTOR_METRIC against existing data silently normalizes scores
		// with the wrong formula.
		if (!msg.includes("Index already exists")) throw err

		let info: unknown
		try {
			info = await redis.send("FT.INFO", [idx])
		} catch (infoErr: unknown) {
			const detail = infoErr instanceof Error ? infoErr.message : String(infoErr)
			throw new Error(`Existing vector index "${idx}" could not be verified via FT.INFO: ${detail}`)
		}
		const actualDim = parseDimensionFromInfo(info)
		if (actualDim === undefined) {
			throw new Error(
				`Existing vector index "${idx}" could not be verified via FT.INFO: no readable DIM attribute`,
			)
		}
		validateIndexCompatibility(
			ns,
			actualDim,
			parseMetricFromInfo(info),
			dimension,
			// FT.INFO reports the Redis-native name (L2/IP/COSINE);
			// compare against what we would have created.
			toRedisDistanceMetric(config.metric),
		)
		cacheIndex(ns, actualDim, generation)
		return
	}
	cacheIndex(ns, dimension, generation)
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

export async function dropIndex(ns: string): Promise<void> {
	const generation = refreshCacheGeneration()
	const idx = indexName(ns)
	const redis = getClient()

	try {
		await redis.send("FT.DROPINDEX", [idx])
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err)
		if (!isMissingIndexError(msg)) {
			throw err
		}
	}

	if (refreshCacheGeneration() === generation) {
		knownIndexes.delete(idx)
		dimensionMap.delete(ns)
	}
}

function isUnknownCommandError(msg: string): boolean {
	const lower = msg.toLowerCase()
	return lower.includes("unknown command") || lower.includes("err unknown")
}

export async function syncIndexes(): Promise<void> {
	const generation = refreshCacheGeneration()
	const redis = getClient()
	let indexes: string[] = []
	try {
		indexes = (await redis.send("FT._LIST", [])) as string[]
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		// RediSearch is required — refuse to start if the module isn't loaded so we
		// don't run with cold dimension caches and silently corrupt indexes later.
		if (isUnknownCommandError(msg)) {
			throw new Error("RediSearch (FT.*) is not available. up-vector requires Redis Stack.")
		}
		log.warn("FT._LIST failed during sync — proceeding with empty cache", { error: msg })
		return
	}

	for (const idx of indexes) {
		// FT._LIST is global to the Redis DB — a shared instance may hold indexes
		// from other applications. Only our idx:{ns} indexes are ours to sync,
		// validate, and cache; adopting foreign ones aborted startup on distance
		// metric mismatches we don't own. (deep audit 2026-09-06, F1)
		if (!idx.startsWith("idx:")) continue
		const ns = idx.slice(4)
		try {
			const info = await redis.send("FT.INFO", [idx])
			const dim = parseDimensionFromInfo(info)
			validateIndexCompatibility(
				ns,
				dim,
				parseMetricFromInfo(info),
				config.dimension,
				toRedisDistanceMetric(config.metric),
			)
			if (dim !== undefined) {
				cacheIndex(ns, dim, generation)
			}
		} catch (err) {
			// Index may have been dropped between _LIST and INFO; a
			// compatibility mismatch aborts startup instead of mis-scoring
			// every query for the process lifetime.
			if (err instanceof ValidationError) throw err
		}
	}

	// Repair namespace registry: ensure every idx:{ns} index has its ns registered
	const registryNamespaces = indexes
		.filter((idx) => idx.startsWith("idx:"))
		.map((idx) => idx.slice(4))
	if (registryNamespaces.length > 0) {
		try {
			await redis.sadd(NS_REGISTRY, ...registryNamespaces)
		} catch (err) {
			log.warn("failed to repair namespace registry", {
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}
}

// Bun.redis uses RESP3, so FT.INFO returns a JS object (not a flat array).
// biome-ignore lint/suspicious/noExplicitAny: FT.INFO response shape varies by Redis version
export function parseNumDocs(info: any): number {
	// RESP3 object format
	if (info && typeof info === "object" && !Array.isArray(info)) {
		return Number(info.num_docs ?? 0)
	}
	// RESP2 flat array fallback
	for (let i = 0; i < info.length - 1; i++) {
		if (info[i] === "num_docs") return Number(info[i + 1])
	}
	return 0
}

// biome-ignore lint/suspicious/noExplicitAny: FT.INFO response shape varies by Redis version
function parseDimensionFromInfo(info: any): number | undefined {
	// RESP3 object format
	if (info && typeof info === "object" && !Array.isArray(info)) {
		const attrs = info.attributes as Array<Record<string, unknown>> | undefined
		if (attrs) {
			for (const field of attrs) {
				if (field.dim !== undefined) return Number(field.dim)
			}
		}
		return undefined
	}
	// RESP2 flat array fallback
	for (let i = 0; i < info.length - 1; i++) {
		if (info[i] === "attributes") {
			const attrs = info[i + 1] as unknown[][]
			for (const field of attrs) {
				for (let j = 0; j < field.length - 1; j++) {
					if ((field[j] === "DIM" || field[j] === "dim") && typeof field[j + 1] !== "undefined") {
						return Number(field[j + 1])
					}
				}
			}
		}
	}
	return undefined
}

// FT.INFO returns either a RESP3 object ({ attributes: [{...}] }) or a RESP2
// flat array ([..., "attributes", [[...], ...]]). The shape varies by Redis
// version, so narrow defensively instead of trusting one shape.
function infoAttributes(info: unknown): unknown[] {
	// RESP3 object form: { attributes: [{...}, ...] }
	if (typeof info === "object" && info !== null && !Array.isArray(info)) {
		const attrs = (info as Record<string, unknown>).attributes
		if (Array.isArray(attrs)) {
			return attrs.filter((a: unknown) => Array.isArray(a) || (typeof a === "object" && a !== null))
		}
	}
	// RESP2 flat form: [..., "attributes", [["TYPE","FLOAT32",...], ...]]
	if (Array.isArray(info)) {
		for (let i = 0; i < info.length - 1; i++) {
			if (info[i] === "attributes" && Array.isArray(info[i + 1])) {
				return info[i + 1].filter(
					(a: unknown) => Array.isArray(a) || (typeof a === "object" && a !== null),
				)
			}
		}
	}
	return []
}

export function parseMetricFromInfo(info: unknown): string | undefined {
	for (const field of infoAttributes(info)) {
		if (Array.isArray(field)) {
			// Attribute rendered as alternating key/value pairs.
			for (let j = 0; j < field.length - 1; j++) {
				if (
					String(field[j]).toUpperCase() === "DISTANCE_METRIC" &&
					typeof field[j + 1] !== "undefined"
				) {
					return String(field[j + 1])
				}
			}
		} else if (typeof field === "object" && field !== null) {
			const record = field as Record<string, unknown> // narrowed by the guard above
			const metric = record.distance_metric ?? record.DISTANCE_METRIC
			if (typeof metric === "string") return metric
		}
	}
	return undefined
}

/**
 * Compare an existing index's FT.INFO attributes against what we would have
 * created. Mismatch means the operator changed UPVECTOR_DIMENSION or
 * UPVECTOR_METRIC against data written under different settings — queries and
 * upserts must fail loudly instead of silently mis-scoring.
 */
export function validateIndexCompatibility(
	ns: string,
	actualDim: number | undefined,
	actualMetric: string | undefined,
	wantDim: number | undefined,
	wantMetric: string,
): void {
	if (actualMetric !== undefined && actualMetric.toUpperCase() !== wantMetric.toUpperCase()) {
		throw new ValidationError(
			`Distance metric mismatch: namespace "${ns}" index expects ${actualMetric}, configured ${wantMetric}`,
		)
	}
	if (actualDim !== undefined && wantDim !== undefined && actualDim !== wantDim) {
		throw new ValidationError(`Dimension mismatch: namespace expects ${actualDim}, got ${wantDim}`)
	}
}
