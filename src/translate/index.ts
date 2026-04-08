import { config } from "../config"
import { ValidationError } from "../errors"
import { log } from "../logger"
import { getClient } from "../redis"
import { indexName, NS_REGISTRY } from "./keys"

const knownIndexes = new Set<string>()
const dimensionMap = new Map<string, number>()
// Per-index in-flight FT.CREATE — serializes concurrent first-upserts so we don't
// fire two FT.CREATE commands and rely on the "Index already exists" catch.
const pendingIndexCreations = new Map<string, Promise<void>>()

export function getDetectedDimension(ns: string): number | undefined {
	return config.dimension ?? dimensionMap.get(ns)
}

export function setDetectedDimension(ns: string, dim: number): void {
	dimensionMap.set(ns, dim)
}

/**
 * Resolve the dimension for a namespace, querying Redis when not cached. This
 * exists for the case where syncIndexes() couldn't run (or failed) at startup
 * and a request hits a namespace whose dimension we don't know yet.
 */
export async function loadDimension(ns: string): Promise<number | undefined> {
	if (config.dimension !== undefined) return config.dimension
	const cached = dimensionMap.get(ns)
	if (cached !== undefined) return cached

	const idx = indexName(ns)
	const redis = getClient()
	try {
		const info = await redis.send("FT.INFO", [idx])
		const dim = parseDimensionFromInfo(info)
		if (dim !== undefined) {
			dimensionMap.set(ns, dim)
			knownIndexes.add(idx)
			return dim
		}
	} catch {
		// Index does not exist yet — that's fine, the caller will create it
	}
	return undefined
}

export async function ensureIndex(ns: string, dimension: number): Promise<void> {
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
		const cached = dimensionMap.get(ns)
		if (cached !== undefined && cached !== dimension) {
			throw new ValidationError(`Dimension mismatch: namespace expects ${cached}, got ${dimension}`)
		}
		return
	}

	const promise = createIndexInternal(ns, dimension, idx)
	pendingIndexCreations.set(idx, promise)
	try {
		await promise
	} finally {
		pendingIndexCreations.delete(idx)
	}
}

async function createIndexInternal(ns: string, dimension: number, idx: string): Promise<void> {
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
			config.metric,
		])
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err)
		if (msg.includes("Index already exists")) {
			// Index exists from a previous run — query its actual dimension and
			// fail loudly if the caller's dimension doesn't match.
			try {
				const info = await redis.send("FT.INFO", [idx])
				const actualDim = parseDimensionFromInfo(info)
				if (actualDim !== undefined) {
					dimensionMap.set(ns, actualDim)
					knownIndexes.add(idx)
					if (actualDim !== dimension) {
						throw new ValidationError(
							`Dimension mismatch: namespace expects ${actualDim}, got ${dimension}`,
						)
					}
					return
				}
			} catch (infoErr) {
				// Bubble up dimension mismatches; tolerate transient FT.INFO failures
				if (infoErr instanceof ValidationError) {
					throw infoErr
				}
			}
		} else {
			throw err
		}
	}

	knownIndexes.add(idx)
	dimensionMap.set(ns, dimension)
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

	knownIndexes.delete(idx)
	dimensionMap.delete(ns)
}

function isUnknownCommandError(msg: string): boolean {
	const lower = msg.toLowerCase()
	return lower.includes("unknown command") || lower.includes("err unknown")
}

export async function syncIndexes(): Promise<void> {
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
		knownIndexes.add(idx)
		try {
			const info = await redis.send("FT.INFO", [idx])
			const dim = parseDimensionFromInfo(info)
			if (dim !== undefined) {
				const ns = idx.startsWith("idx:") ? idx.slice(4) : idx
				dimensionMap.set(ns, dim)
			}
		} catch {
			// Index may have been dropped between _LIST and INFO
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
