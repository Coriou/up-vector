import { type Context, Hono } from "hono"
import { getClient } from "../redis"
import { parseVectorKey, validateNamespace, vectorPrefix } from "../translate/keys"
import { decodeVectorBase64 } from "../translate/vectors"
import type { Vector } from "../types"

const MAX_SCAN_ITERATIONS = 10_000

export const randomRoutes = new Hono()

const handleRandom = async (c: Context) => {
	const ns = c.req.param("namespace") ?? ""
	validateNamespace(ns)
	const redis = getClient()
	const pattern = `${vectorPrefix(ns)}*`

	let cursor = "0"
	let iterations = 0
	let seen = 0
	let selectedKey: string | undefined

	// Reservoir sample over the namespace so every matching key has equal
	// probability without materializing the full namespace in memory.
	do {
		if (++iterations > MAX_SCAN_ITERATIONS) break
		const result = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100)
		const [next, keys] = result as unknown as [string, string[]]

		for (const key of keys) {
			seen++
			if (Math.floor(Math.random() * seen) === 0) {
				selectedKey = key
			}
		}

		cursor = next
	} while (cursor !== "0")

	if (!selectedKey) {
		return c.json({ result: null })
	}

	const hash = await redis.hgetall(selectedKey)
	if (!hash?._vec) {
		return c.json({ result: null })
	}

	const parsedKey = parseVectorKey(selectedKey)
	const vector: Vector = {
		id: parsedKey?.id ?? hash.id ?? selectedKey,
		vector: decodeVectorBase64(hash._vec),
	}

	return c.json({ result: vector })
}

randomRoutes.get("/random/:namespace?", handleRandom)
randomRoutes.post("/random/:namespace?", handleRandom)
