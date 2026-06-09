import { type Context, Hono } from "hono"
import { z } from "zod"
import { ValidationError } from "../errors"
import { getClient } from "../redis"
import { dropIndex, ensureIndex, loadDimension } from "../translate/index"
import {
	deleteKeysByPattern,
	NS_REGISTRY,
	parseVectorKey,
	validateNamespace,
	vectorKey,
	vectorPrefix,
} from "../translate/keys"

export const namespaceRoutes = new Hono()

// List namespaces
const handleList = async (c: Context) => {
	const redis = getClient()
	const namespaces = await redis.smembers(NS_REGISTRY)
	return c.json({ result: namespaces.includes("") ? namespaces : ["", ...namespaces] })
}

namespaceRoutes.get("/list-namespaces", handleList)
namespaceRoutes.post("/list-namespaces", handleList)

// Delete namespace
const handleDeleteNamespace = async (c: Context) => {
	const ns = c.req.param("namespace")
	if (!ns) {
		return c.json({ error: "Namespace is required", status: 400 }, 400)
	}
	validateNamespace(ns)
	const redis = getClient()

	await dropIndex(ns)
	await deleteKeysByPattern(`${vectorPrefix(ns)}*`)
	await redis.srem(NS_REGISTRY, ns)

	return c.json({ result: "Success" })
}

namespaceRoutes.delete("/delete-namespace/:namespace", handleDeleteNamespace)
namespaceRoutes.post("/delete-namespace/:namespace", handleDeleteNamespace)

const RenameNamespaceBody = z.object({
	namespace: z.string(),
	newNamespace: z.string(),
	deleteExisting: z.boolean().default(false),
})

const MAX_SCAN_ITERATIONS = 10_000

namespaceRoutes.post("/rename-namespace", async (c) => {
	const body = await c.req.json()
	const parsed = RenameNamespaceBody.parse(body)

	validateNamespace(parsed.namespace)
	validateNamespace(parsed.newNamespace)

	if (parsed.namespace === "") {
		throw new ValidationError("Default namespace cannot be renamed")
	}
	if (parsed.newNamespace === "") {
		throw new ValidationError("New namespace must not be the default namespace")
	}
	if (parsed.namespace === parsed.newNamespace) {
		return c.json({ result: { renamed: true } })
	}

	const redis = getClient()
	const sourceExists = await namespaceExists(parsed.namespace)
	if (!sourceExists) {
		return c.json({ result: { renamed: false } })
	}

	const targetExists = await namespaceExists(parsed.newNamespace)
	if (targetExists && !parsed.deleteExisting) {
		return c.json({ result: { renamed: false } })
	}

	if (targetExists) {
		await dropIndex(parsed.newNamespace)
		await deleteKeysByPattern(`${vectorPrefix(parsed.newNamespace)}*`)
		await redis.srem(NS_REGISTRY, parsed.newNamespace)
	}

	const sourceKeys = await scanKeys(`${vectorPrefix(parsed.namespace)}*`)
	const sourceDimension =
		(await loadDimension(parsed.namespace)) ?? (await inferDimensionFromKeys(sourceKeys))

	await dropIndex(parsed.namespace)

	for (const sourceKey of sourceKeys) {
		const parsedKey = parseVectorKey(sourceKey)
		if (!parsedKey) continue
		await redis.rename(sourceKey, vectorKey(parsed.newNamespace, parsedKey.id))
	}

	await redis.srem(NS_REGISTRY, parsed.namespace)
	await redis.sadd(NS_REGISTRY, parsed.newNamespace)

	if (sourceDimension !== undefined) {
		await ensureIndex(parsed.newNamespace, sourceDimension)
	}

	return c.json({ result: { renamed: true } })
})

async function namespaceExists(ns: string): Promise<boolean> {
	const redis = getClient()
	if (await redis.sismember(NS_REGISTRY, ns)) return true

	const keys = await scanKeys(`${vectorPrefix(ns)}*`, 1)
	if (keys.length > 0) return true

	const dimension = await loadDimension(ns)
	return dimension !== undefined
}

async function scanKeys(pattern: string, limit = Number.POSITIVE_INFINITY): Promise<string[]> {
	const redis = getClient()
	const keys = new Set<string>()
	let cursor = "0"
	let iterations = 0

	do {
		if (++iterations > MAX_SCAN_ITERATIONS) break
		const result = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100)
		const [next, batch] = result as unknown as [string, string[]]
		for (const key of batch) {
			keys.add(key)
			if (keys.size >= limit) break
		}
		cursor = next
		if (keys.size >= limit) break
	} while (cursor !== "0")

	return Array.from(keys)
}

async function inferDimensionFromKeys(keys: string[]): Promise<number | undefined> {
	const redis = getClient()
	for (const key of keys) {
		const encoded = await redis.hget(key, "_vec")
		if (!encoded) continue
		const byteLength = Buffer.from(encoded, "base64").byteLength
		if (byteLength > 0 && byteLength % 4 === 0) {
			return byteLength / 4
		}
	}
	return undefined
}
