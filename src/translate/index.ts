import { config } from "../config"
import { log } from "../logger"
import { getClient } from "../redis"
import { indexName, NS_REGISTRY } from "./keys"

const knownIndexes = new Set<string>()
const dimensionMap = new Map<string, number>()

export function getDetectedDimension(ns: string): number | undefined {
	return config.dimension ?? dimensionMap.get(ns)
}

export function setDetectedDimension(ns: string, dim: number): void {
	dimensionMap.set(ns, dim)
}

export async function ensureIndex(ns: string, dimension: number): Promise<void> {
	const idx = indexName(ns)
	if (knownIndexes.has(idx)) return

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
		if (!msg.includes("Index already exists")) {
			throw err
		}
	}

	knownIndexes.add(idx)
	dimensionMap.set(ns, dimension)
}

export async function dropIndex(ns: string): Promise<void> {
	const idx = indexName(ns)
	const redis = getClient()

	try {
		await redis.send("FT.DROPINDEX", [idx])
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err)
		if (
			!msg.includes("Unknown index") &&
			!msg.includes("Unknown Index") &&
			!msg.includes("No such index")
		) {
			throw err
		}
	}

	knownIndexes.delete(idx)
	dimensionMap.delete(ns)
}

export async function syncIndexes(): Promise<void> {
	const redis = getClient()
	let indexes: string[] = []
	try {
		indexes = (await redis.send("FT._LIST", [])) as string[]
	} catch {
		log.warn("FT._LIST not available, skipping index sync")
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
