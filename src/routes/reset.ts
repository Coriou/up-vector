import { type Context, Hono } from "hono"
import { getClient } from "../redis"
import { dropIndex } from "../translate/index"
import { deleteKeysByPattern, NS_REGISTRY, vectorPrefix } from "../translate/keys"

export const resetRoutes = new Hono()

const handleReset = async (c: Context) => {
	const ns = c.req.param("namespace") ?? ""
	const all = c.req.query("all") !== undefined
	const redis = getClient()

	if (all) {
		// Reset all namespaces
		const namespaces = await redis.smembers(NS_REGISTRY)
		await Promise.all(namespaces.map((n) => dropIndex(n)))
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
