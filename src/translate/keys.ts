import { getClient } from "../redis"

export const NS_REGISTRY = "_ns_registry"

export function vectorKey(ns: string, id: string): string {
	return `v:${ns}:${id}`
}

export function vectorPrefix(ns: string): string {
	return `v:${ns}:`
}

export function indexName(ns: string): string {
	return `idx:${ns}`
}

export function parseVectorKey(key: string): { ns: string; id: string } | null {
	if (!key.startsWith("v:")) return null
	// Format: v:{ns}:{id} — ns never contains ":", but id can
	const afterV = key.slice(2) // remove "v:"
	const colonIdx = afterV.indexOf(":")
	if (colonIdx === -1) return null
	return {
		ns: afterV.slice(0, colonIdx),
		id: afterV.slice(colonIdx + 1),
	}
}

export async function deleteKeysByPattern(pattern: string): Promise<number> {
	const redis = getClient()
	let cursor = "0"
	let totalDeleted = 0
	do {
		const result = await redis.scan(Number(cursor), "MATCH", pattern, "COUNT", 100)
		const [next, keys] = result as unknown as [string, string[]]
		if (keys.length > 0) {
			totalDeleted += await redis.del(...keys)
		}
		cursor = String(next)
	} while (cursor !== "0")
	return totalDeleted
}
