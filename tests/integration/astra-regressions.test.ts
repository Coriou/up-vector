import { afterAll, beforeAll, expect, test } from "bun:test"
import { closeRedis, getClient, initRedis, isRedisHealthy, reinitRedis } from "../../src/redis"
import { ensureIndex, getDetectedDimension } from "../../src/translate/index"
import { api } from "./setup"

beforeAll(initRedis)
afterAll(closeRedis)

test("slow connected Redis is not closed by self-heal", async () => {
	const original = getClient()
	await original.send("CLIENT", ["PAUSE", "2300", "ALL"])
	const pending = original.ping().catch(() => "CLOSED")
	expect(await Promise.all([isRedisHealthy(), isRedisHealthy()])).toEqual([false, false])
	await reinitRedis()
	expect(getClient()).toBe(original)
	expect(await pending).toBe("PONG")
}, 10000)

test("new Redis client invalidates cached namespace indexes and dimensions", async () => {
	const ns = "astra-replacement"
	await ensureIndex(ns, 3)
	await getClient().send("FT.DROPINDEX", [`idx:${ns}`])
	await closeRedis()
	await initRedis()
	expect(getDetectedDimension(ns)).toBeUndefined()
	await ensureIndex(ns, 4)
	const info = await getClient().send("FT.INFO", [`idx:${ns}`])
	expect(info).toBeDefined()
	await getClient().send("FT.DROPINDEX", [`idx:${ns}`])
})

test("PATCH preserves empty arrays, objects and numeric precision", async () => {
	const ns = "astra-json-patch"
	try {
		expect(
			(
				await api("POST", `/upsert/${ns}`, {
					id: "one",
					vector: [1, 0, 0],
					metadata: {
						untouched: [],
						precise: 9007199254740991,
						items: [1],
						object: { keep: true },
					},
				})
			).status,
		).toBe(200)
		expect(
			(
				await api("POST", `/update/${ns}`, {
					id: "one",
					metadataUpdateMode: "PATCH",
					metadata: { items: [], object: {}, added: [] },
				})
			).status,
		).toBe(200)
		const result = await api("POST", `/fetch/${ns}`, { ids: ["one"], includeMetadata: true })
		expect((result.data as { result: { metadata: unknown }[] }).result[0].metadata).toEqual({
			untouched: [],
			precise: 9007199254740991,
			items: [],
			object: { keep: true },
			added: [],
		})
	} finally {
		await api("DELETE", `/delete-namespace/${ns}`)
	}
})

test("timed-out namespace deletion stops after its in-flight command", async () => {
	const { Hono } = await import("hono")
	const { config } = await import("../../src/config")
	const { timeoutMiddleware } = await import("../../src/middleware/timeout")
	const { errorHandler } = await import("../../src/middleware/error-handler")
	const { namespaceRoutes } = await import("../../src/routes/namespaces")
	const originalTimeout = config.requestTimeout
	const ns = "astra-timeout"
	const redis = getClient()
	const completed = Promise.withResolvers<void>()
	const local = new Hono()
		.onError(errorHandler)
		.use("*", timeoutMiddleware)
		.use("*", async (_c, next) => {
			try {
				await next()
			} finally {
				completed.resolve()
			}
		})
		.route("/", namespaceRoutes)
	try {
		await ensureIndex(ns, 3)
		await redis.send("HSET", [`v:${ns}:one`, "data", "must-survive"])
		await redis.sadd("_ns_registry", ns)
		config.requestTimeout = 20
		await redis.send("CLIENT", ["PAUSE", "150", "ALL"])
		const response = await local.request(`/delete-namespace/${ns}`, { method: "DELETE" })
		expect(response.status).toBe(504)
		// Wait for the late handler, not just a PING queued before its SCAN.
		// No subsequent SCAN/DEL/SREM may be issued after the deadline.
		await completed.promise
		expect(await redis.exists(`v:${ns}:one`)).toBe(true)
		expect(await redis.sismember("_ns_registry", ns)).toBe(true)
	} finally {
		config.requestTimeout = originalTimeout
		await redis.del(`v:${ns}:one`)
		await redis.srem("_ns_registry", ns)
	}
})

test("concurrent PATCH writers preserve each other's disjoint changes", async () => {
	const ns = "astra-patch-concurrency"
	try {
		await api("POST", `/upsert/${ns}`, { id: "one", vector: [1, 0, 0], metadata: { base: [] } })
		const responses = await Promise.all(
			["a", "b", "c", "d"].map((key) =>
				api("POST", `/update/${ns}`, {
					id: "one",
					metadataUpdateMode: "PATCH",
					metadata: { [key]: [] },
				}),
			),
		)
		expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200])
		const fetched = await api("POST", `/fetch/${ns}`, { ids: ["one"], includeMetadata: true })
		expect((fetched.data as { result: { metadata: unknown }[] }).result[0].metadata).toEqual({
			base: [],
			a: [],
			b: [],
			c: [],
			d: [],
		})
	} finally {
		await api("DELETE", `/delete-namespace/${ns}`)
	}
})

test("automatic reconnect also invalidates index caches", async () => {
	const { RedisClient } = await import("bun")
	const { config } = await import("../../src/config")
	const control = new RedisClient(config.redisUrl)
	const ns = "astra-reconnect"
	try {
		await ensureIndex(ns, 3)
		const redis = getClient()
		const id = await redis.send("CLIENT", ["ID"])
		await control.send("FT.DROPINDEX", [`idx:${ns}`])
		await control.send("CLIENT", ["KILL", "ID", String(id)])
		// Allow onclose to run, then use the native reconnect/offline queue.
		await new Promise((resolve) => setTimeout(resolve, 100))
		await redis.ping()
		expect(getDetectedDimension(ns)).toBeUndefined()
		await ensureIndex(ns, 4)
		expect(await redis.send("FT.INFO", [`idx:${ns}`])).toBeDefined()
		await redis.send("FT.DROPINDEX", [`idx:${ns}`])
	} finally {
		control.close()
	}
}, 15000)

test("PATCH contention exhausts retries without partially writing vector or data", async () => {
	const { Hono } = await import("hono")
	const { errorHandler } = await import("../../src/middleware/error-handler")
	const { updateRoutes } = await import("../../src/routes/update")
	const redis = getClient()
	const originalSend = redis.send
	const ns = "astra-patch-conflict"
	const key = `v:${ns}:one`
	let competingWrites = 0
	try {
		await api("POST", `/upsert/${ns}`, {
			id: "one",
			vector: [1, 0, 0],
			data: "original",
			metadata: { revision: 0 },
		})
		redis.send = async (command, args) => {
			if (command === "EVAL" && args[2] === key) {
				await originalSend("HSET", [
					key,
					"metadata",
					JSON.stringify({ revision: ++competingWrites }),
				])
			}
			return originalSend(command, args)
		}
		const local = new Hono().onError(errorHandler).route("/", updateRoutes)
		const response = await local.request(`/update/${ns}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				id: "one",
				vector: [0, 1, 0],
				data: "changed",
				metadata: { mine: true },
				metadataUpdateMode: "PATCH",
			}),
		})
		expect(response.status).toBe(409)
		expect(competingWrites).toBe(8)
		const fetched = await api("POST", `/fetch/${ns}`, {
			ids: ["one"],
			includeMetadata: true,
			includeData: true,
			includeVectors: true,
		})
		expect((fetched.data as { result: unknown[] }).result[0]).toEqual({
			id: "one",
			vector: [1, 0, 0],
			data: "original",
			metadata: { revision: 8 },
		})
	} finally {
		redis.send = originalSend
		await api("DELETE", `/delete-namespace/${ns}`)
	}
})
