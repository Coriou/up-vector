import { describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import { errorHandler } from "../../src/middleware/error-handler"

const evalResult = 1
const fakeRedis = {
	sismember: async () => 0,
	send: async () => evalResult,
}

mock.module("../../src/redis", () => ({
	getClient: () => fakeRedis,
	// Mirror the real module's remaining exports: other suites in the same
	// process statically bind isRedisHealthy et al.
	initRedis: async () => {},
	isRedisHealthy: async () => true,
	reinitRedis: async () => {},
	closeRedis: async () => {},
}))

// Dynamic import (not static): the route modules must bind the redis stub
// mock.module registered above — static hoisting would bind the real module.
const [{ updateRoutes }, { dataRoutes }] = await Promise.all([
	import("../../src/routes/update"),
	import("../../src/routes/data"),
])

function appWith(routes: Hono): Hono {
	const app = new Hono()
	app.onError(errorHandler)
	app.route("/", routes)
	return app
}

async function postJson(app: Hono, path: string, body: unknown): Promise<Response> {
	return app.request(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	})
}

const oversizeMetadata = (): Record<string, string> => {
	const metadata: Record<string, string> = {}
	for (let i = 0; i < 1500; i++) metadata[`key-${i}`] = "y".repeat(200)
	return metadata
}

// /upsert caps serialized metadata at 131072 bytes and data at 1_000_000
// characters "regardless of entry point" — but /update and /upsert-data
// bypassed both, letting a single request persist ~32MiB that every
// includeMetadata/includeData read retransfers. (deep audit 2026-09-06, F4)
describe("/update enforces the /upsert size budgets", () => {
	test("rejects metadata past the 131072-byte budget", async () => {
		const res = await postJson(appWith(updateRoutes), "/update", {
			id: "doc-1",
			metadata: oversizeMetadata(),
		})
		expect(res.status).toBe(400)
		const json = (await res.json()) as { error?: string }
		expect(json.error).toBe("Serialized metadata must not exceed 131072 bytes")
	})

	test("rejects data past the 1_000_000-character budget", async () => {
		const res = await postJson(appWith(updateRoutes), "/update", {
			id: "doc-1",
			data: "x".repeat(1_000_001),
		})
		expect(res.status).toBe(400)
		const json = (await res.json()) as { error?: string }
		expect(json.error).toBe("Data must not exceed 1000000 characters")
	})

	test("accepts metadata within the budget", async () => {
		// Regression guard against over-tightening: valid payloads still reach
		// the Lua update.
		const res = await postJson(appWith(updateRoutes), "/update", {
			id: "doc-1",
			metadata: { source: "test" },
		})
		expect(res.status).toBe(200)
	})
})

describe("/upsert-data enforces the /upsert metadata budget", () => {
	test("rejects item metadata past the 131072-byte budget", async () => {
		const res = await postJson(appWith(dataRoutes), "/upsert-data", {
			id: "doc-1",
			data: "hello",
			metadata: oversizeMetadata(),
		})
		expect(res.status).toBe(400)
		const json = (await res.json()) as { error?: string }
		expect(json.error).toBe("Serialized metadata must not exceed 131072 bytes")
	})
})
