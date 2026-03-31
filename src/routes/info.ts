import { type Context, Hono } from "hono"
import { config } from "../config"
import { getClient } from "../redis"
import { getDetectedDimension, parseNumDocs } from "../translate/index"
import { indexName, NS_REGISTRY } from "../translate/keys"

export const infoRoutes = new Hono()

const handleInfo = async (c: Context) => {
	const redis = getClient()
	const namespaceNames = await redis.smembers(NS_REGISTRY)

	const namespaces: Record<string, { vectorCount: number; pendingVectorCount: number }> = {}
	let totalVectorCount = 0
	let detectedDimension = config.dimension ?? 0

	for (const ns of namespaceNames) {
		let vectorCount = 0
		try {
			const info = (await redis.send("FT.INFO", [indexName(ns)])) as unknown[]
			vectorCount = parseNumDocs(info)
		} catch {
			// Index might not exist (namespace registered but no vectors upserted yet)
		}

		namespaces[ns] = { vectorCount, pendingVectorCount: 0 }
		totalVectorCount += vectorCount

		// Pick up dimension from any namespace that has one
		if (detectedDimension === 0) {
			const dim = getDetectedDimension(ns)
			if (dim !== undefined) detectedDimension = dim
		}
	}

	// If no namespaces registered, still check the default namespace
	if (namespaceNames.length === 0) {
		namespaces[""] = { vectorCount: 0, pendingVectorCount: 0 }
	}

	return c.json({
		result: {
			vectorCount: totalVectorCount,
			pendingVectorCount: 0,
			dimension: detectedDimension,
			similarityFunction: config.metric,
			namespaces,
		},
	})
}

infoRoutes.get("/info", handleInfo)
infoRoutes.post("/info", handleInfo)
