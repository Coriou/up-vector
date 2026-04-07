import { type Context, Hono } from "hono"
import { log } from "../logger"
import { getClient } from "../redis"
import { dropIndex } from "../translate/index"
import {
	deleteKeysByPattern,
	NS_REGISTRY,
	validateNamespace,
	vectorPrefix,
} from "../translate/keys"

export const resetRoutes = new Hono()

const handleReset = async (c: Context) => {
	const ns = c.req.param("namespace") ?? ""
	validateNamespace(ns)
	const all = c.req.query("all") !== undefined
	const redis = getClient()

	if (all) {
		// Reset all namespaces
		const namespaces = await redis.smembers(NS_REGISTRY)

		// Also discover any orphaned indexes not in the registry
		let allIndexes: string[] = []
		try {
			allIndexes = (await redis.send("FT._LIST", [])) as string[]
		} catch {
			// FT._LIST may not be available in older Redis versions
		}

		// Drop everything we know about — registered namespaces plus any orphaned
		// idx:* indexes — even if some drops fail. Use allSettled so one failure
		// doesn't abort the rest of the cleanup.
		const droppedSet = new Set(namespaces.map((n) => `idx:${n}`))
		const orphanNamespaces = allIndexes
			.filter((idx) => idx.startsWith("idx:") && !droppedSet.has(idx))
			.map((idx) => idx.slice(4))
		const dropTargets = [...namespaces, ...orphanNamespaces]
		const dropResults = await Promise.allSettled(dropTargets.map((n) => dropIndex(n)))
		for (let i = 0; i < dropResults.length; i++) {
			const result = dropResults[i]
			if (result.status === "rejected") {
				log.warn("dropIndex failed during reset all", {
					namespace: dropTargets[i],
					error: result.reason instanceof Error ? result.reason.message : String(result.reason),
				})
			}
		}

		await deleteKeysByPattern("v:*")
		await redis.del(NS_REGISTRY)
	} else {
		// Reset single namespace
		await dropIndex(ns)
		await deleteKeysByPattern(`${vectorPrefix(ns)}*`)
		await redis.srem(NS_REGISTRY, ns)
	}

	return c.json({ result: "Success" })
}

resetRoutes.post("/reset/:namespace?", handleReset)
resetRoutes.delete("/reset/:namespace?", handleReset)
