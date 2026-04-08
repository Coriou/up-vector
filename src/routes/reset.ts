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
		// Reset every namespace we know about. We deliberately do *not* fall back
		// to a blanket `v:*` SCAN here — that would clobber unrelated keys in a
		// shared Redis instance, which has bitten people before. Instead we union
		// the namespace registry with any indexes that exist as `idx:*`, then
		// delete only those namespaces' key prefixes.
		const namespaces = await redis.smembers(NS_REGISTRY)

		let allIndexes: string[] = []
		try {
			allIndexes = (await redis.send("FT._LIST", [])) as string[]
		} catch {
			// FT._LIST may not be available in older Redis versions
		}

		const orphanNamespaces = allIndexes
			.filter((idx) => idx.startsWith("idx:"))
			.map((idx) => idx.slice(4))
		const dropTargets = Array.from(new Set([...namespaces, ...orphanNamespaces]))

		// Drop indexes (best-effort) — failures shouldn't block the rest of the
		// cleanup. Use allSettled so a missing/half-broken index doesn't abort.
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

		// Delete each namespace's key range explicitly. Doing it per-namespace
		// keeps the SCAN MATCH narrow and bounded — and crucially never touches
		// keys that don't belong to up-vector.
		for (const n of dropTargets) {
			await deleteKeysByPattern(`${vectorPrefix(n)}*`)
		}

		// Wipe the registry last so a partial failure leaves the registry as a
		// pointer to the leftover keys.
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
