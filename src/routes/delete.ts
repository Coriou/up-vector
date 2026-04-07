import { type Context, Hono } from "hono"
import { z } from "zod"
import type { FilterNode } from "../filter"
import { compileFilter, evaluate } from "../filter"
import { getClient } from "../redis"
import { deleteKeysByPattern, validateNamespace, vectorKey, vectorPrefix } from "../translate/keys"

const MAX_SCAN_ITERATIONS = 10_000
const MAX_ID_LENGTH = 1024

const idSchema = z
	.union([z.string(), z.number()])
	.transform(String)
	.refine((s) => s.length > 0, "Vector ID must not be empty")
	.refine((s) => s.length <= MAX_ID_LENGTH, `Vector ID must not exceed ${MAX_ID_LENGTH} characters`)

const DeleteBody = z
	.object({
		ids: z.array(idSchema).max(1000, "Batch must not exceed 1000 ids").optional(),
		prefix: z.string().optional(),
		filter: z.string().optional(),
	})
	.refine((data) => [data.ids, data.prefix, data.filter].filter(Boolean).length <= 1, {
		message: "Only one of ids, prefix, or filter can be specified",
	})

export const deleteRoutes = new Hono()

const handleDelete = async (c: Context) => {
	const body = await c.req.json()
	const parsed = DeleteBody.parse(body)
	const ns = c.req.param("namespace") ?? ""
	validateNamespace(ns)
	const redis = getClient()

	// Delete by IDs
	if (parsed.ids) {
		if (parsed.ids.length === 0) {
			return c.json({ result: { deleted: 0 } })
		}
		const keys = parsed.ids.map((id) => vectorKey(ns, id))
		const deleted = await redis.del(...keys)
		return c.json({ result: { deleted } })
	}

	// Delete by prefix
	if (parsed.prefix) {
		const pattern = `${vectorPrefix(ns)}${parsed.prefix}*`
		const deleted = await deleteKeysByPattern(pattern)
		return c.json({ result: { deleted } })
	}

	// Delete by filter — O(N) scan, same as Upstash
	if (parsed.filter) {
		const pattern = `${vectorPrefix(ns)}*`
		const deleted = await deleteByFilter(redis, pattern, parsed.filter)
		return c.json({ result: { deleted } })
	}

	// Nothing specified
	return c.json({ result: { deleted: 0 } })
}

async function deleteByFilter(
	redis: ReturnType<typeof getClient>,
	pattern: string,
	filter: string,
): Promise<number> {
	// Parse filter once (LRU-cached across requests)
	const ast: FilterNode = compileFilter(filter)

	let cursor = "0"
	let totalDeleted = 0
	let iterations = 0

	do {
		if (++iterations > MAX_SCAN_ITERATIONS) break
		const result = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100)
		const [next, keys] = result as unknown as [string, string[]]

		if (keys.length > 0) {
			// Fetch metadata for each key in parallel
			const metadatas = await Promise.all(keys.map((key) => redis.hget(key, "metadata")))

			const toDelete: string[] = []
			for (let i = 0; i < keys.length; i++) {
				const raw = metadatas[i]
				if (!raw) continue
				try {
					const meta = JSON.parse(raw) as Record<string, unknown>
					if (evaluate(ast, meta)) {
						toDelete.push(keys[i])
					}
				} catch {
					// Invalid metadata JSON — skip
				}
			}

			if (toDelete.length > 0) {
				totalDeleted += await redis.del(...toDelete)
			}
		}

		cursor = next
	} while (cursor !== "0")

	return totalDeleted
}

deleteRoutes.post("/delete/:namespace?", handleDelete)
deleteRoutes.delete("/delete/:namespace?", handleDelete)
