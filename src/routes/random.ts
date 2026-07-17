import { type Context, Hono } from "hono"
import { z } from "zod"
import { getClient } from "../redis"
import { parseVectorKey, validateNamespace, vectorPrefix } from "../translate/keys"
import { decodeVectorBase64 } from "../translate/vectors"
import type { Vector } from "../types"

const MAX_SCAN_ITERATIONS = 10_000

const RandomBody = z.object({
	includeMetadata: z.boolean().default(false),
	includeVectors: z.boolean().default(true),
	includeData: z.boolean().default(false),
})

export const randomRoutes = new Hono()

function parseBoolParam(raw: string | undefined, defaultValue: boolean): boolean {
	if (raw === undefined) return defaultValue
	if (raw === "true" || raw === "1") return true
	if (raw === "false" || raw === "0") return false
	return defaultValue
}

async function parseRandomOptions(c: Context): Promise<z.infer<typeof RandomBody>> {
	if (c.req.method === "GET") {
		return {
			includeMetadata: parseBoolParam(c.req.query("includeMetadata"), false),
			includeVectors: parseBoolParam(c.req.query("includeVectors"), true),
			includeData: parseBoolParam(c.req.query("includeData"), false),
		}
	}

	// POST: empty body → defaults; non-empty invalid JSON → SyntaxError → 400 via errorHandler
	const text = await c.req.text()
	if (!text.trim()) {
		return RandomBody.parse({})
	}
	return RandomBody.parse(JSON.parse(text))
}

function buildRandomVector(
	hash: Record<string, string>,
	id: string,
	opts: z.infer<typeof RandomBody>,
): Vector {
	const vec: Vector = { id }
	if (opts.includeVectors && hash._vec) {
		vec.vector = decodeVectorBase64(hash._vec)
	}
	if (opts.includeMetadata && hash.metadata) {
		try {
			vec.metadata = JSON.parse(hash.metadata)
		} catch {
			// Malformed metadata JSON — skip
		}
	}
	if (opts.includeData && hash.data !== undefined) {
		vec.data = hash.data
	}
	return vec
}

const handleRandom = async (c: Context) => {
	const opts = await parseRandomOptions(c)
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
	if (!hash || Object.keys(hash).length === 0) {
		return c.json({ result: null })
	}

	// Need at least one stored field; empty hash already handled. If vectors
	// are omitted by flag, still return id (+ optional metadata/data).
	if (!hash._vec && !hash.metadata && hash.data === undefined) {
		return c.json({ result: null })
	}

	const parsedKey = parseVectorKey(selectedKey)
	const id = parsedKey?.id ?? hash.id ?? selectedKey
	return c.json({ result: buildRandomVector(hash, id, opts) })
}

randomRoutes.get("/random/:namespace?", handleRandom)
randomRoutes.post("/random/:namespace?", handleRandom)
