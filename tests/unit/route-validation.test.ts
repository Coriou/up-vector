import { describe, expect, mock, test } from "bun:test"
import type { RedisClient } from "bun"
import { Hono } from "hono"
import { ValidationError } from "../../src/errors"
import { errorHandler } from "../../src/middleware/error-handler"

// Routes resolve the Redis client lazily via getClient(); register the stub
// BEFORE the route modules load, so their `../redis` bindings pick up the mock.
let scanImpl: (cursor: string) => Promise<[string, string[]]> = async () => {
	throw new Error("unexpected SCAN call")
}
const delCalls: string[][] = []
const fakeRedis = {
	hgetall: async () => ({}),
	hget: async () => null,
	exists: async () => 1,
	hmget: async () => [null, null, null],
	del: async (...keys: string[]) => {
		delCalls.push(keys)
		return keys.length
	},
	scan: (cursor: string) => scanImpl(cursor),
	// FT.DROPINDEX during reset: missing-index wording so dropIndex swallows it
	// and the SCAN cap is what surfaces.
	send: async () => {
		throw new Error("Unknown index name")
	},
	sadd: async () => 1,
	srem: async () => 1,
	smembers: async () => [],
}

mock.module("../../src/redis", () => ({
	getClient: () => fakeRedis,
	// Full export surface: these modules share the test process with files
	// whose code statically binds other named exports from ../redis.
	initRedis: async () => {},
	isRedisHealthy: async () => true,
	reinitRedis: async () => {},
	closeRedis: async () => {},
}))

// Dynamic imports are required here: the route modules must be evaluated after
// mock.module registers the redis stub, which static hoisting prevents.
const [
	{ deleteRoutes },
	{ fetchRoutes },
	{ collectScanKeys, rangeRoutes },
	{ resetRoutes },
	{ randomRoutes },
] = await Promise.all([
	import("../../src/routes/delete"),
	import("../../src/routes/fetch"),
	import("../../src/routes/range"),
	import("../../src/routes/reset"),
	import("../../src/routes/random"),
])

// Bun's RedisClient can't be constructed in tests; the stub implements the
// subset of methods these handlers call.
const stubClient = fakeRedis as unknown as RedisClient

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

interface Envelope {
	error?: string
	status?: number
	result?: {
		deleted?: number
		nextCursor?: string
		vectors?: Array<{ id: string }>
	}
}

describe("fetch ID validation parity with write path", () => {
	test("rejects an id containing a control character", async () => {
		const res = await postJson(appWith(fetchRoutes), "/fetch/ns", { ids: ["a\nb"] })
		expect(res.status).toBe(400)
		const json = (await res.json()) as Envelope
		expect(json.error).toBe("Vector ID must not contain control characters")
	})

	test("rejects an empty id", async () => {
		const res = await postJson(appWith(fetchRoutes), "/fetch/ns", { ids: [""] })
		expect(res.status).toBe(400)
		const json = (await res.json()) as Envelope
		expect(json.error).toBe("Vector ID must not be empty")
	})

	test("still accepts plain string ids", async () => {
		const res = await postJson(appWith(fetchRoutes), "/fetch/ns", { ids: ["doc-1"] })
		expect(res.status).toBe(200)
	})
})

describe("delete ID validation parity with write path", () => {
	test("rejects an id containing a control character without touching redis", async () => {
		const before = delCalls.length
		const res = await postJson(appWith(deleteRoutes), "/delete/ns", { ids: ["a\nb"] })
		expect(res.status).toBe(400)
		const json = (await res.json()) as Envelope
		expect(json.error).toBe("Vector ID must not contain control characters")
		expect(delCalls.length).toBe(before)
	})

	test("rejects an over-length id", async () => {
		const res = await postJson(appWith(deleteRoutes), "/delete/ns", { ids: ["x".repeat(1025)] })
		expect(res.status).toBe(400)
	})

	test("still deletes plain string ids", async () => {
		const res = await postJson(appWith(deleteRoutes), "/delete/ns", { ids: ["doc-1"] })
		expect(res.status).toBe(200)
		const json = (await res.json()) as Envelope
		expect(json.result?.deleted).toBe(1)
	})
})

describe("collectScanKeys", () => {
	test("returns deduplicated keys when the scan terminates", async () => {
		scanImpl = async (cursor: string): Promise<[string, string[]]> =>
			cursor === "0" ? ["5", ["v:ns:b", "v:ns:a"]] : ["0", ["v:ns:a"]]
		const keys = await collectScanKeys(stubClient, "v:ns:*", 10)
		expect([...keys].sort()).toEqual(["v:ns:a", "v:ns:b"])
	})

	test("throws instead of silently truncating when the iteration cap is hit", async () => {
		scanImpl = async (): Promise<[string, string[]]> => ["9", ["v:ns:x"]]
		let caught: unknown
		try {
			await collectScanKeys(stubClient, "v:ns:*", 3)
		} catch (err) {
			caught = err
		}
		expect(caught).toBeInstanceOf(ValidationError)
		if (caught instanceof Error) {
			expect(caught.message).toContain("exceeds the scanable key limit")
		}
	})
})

describe("range endpoint behavior below the scan cap", () => {
	test("returns a complete page with an empty nextCursor", async () => {
		scanImpl = async (): Promise<[string, string[]]> => ["0", ["v:ns:b", "v:ns:a"]]
		const res = await postJson(appWith(rangeRoutes), "/range/ns", { cursor: "", limit: 100 })
		expect(res.status).toBe(200)
		const json = (await res.json()) as Envelope
		expect(json.result?.nextCursor).toBe("")
		expect(json.result?.vectors?.map((v) => v.id)).toEqual(["a", "b"])
	})
})

describe("explicit-id caps match Upstash (no 1000 limit)", () => {
	test("fetch accepts 1001 ids", async () => {
		// Upstash documents the 1000-result cap only for prefix fetches; an
		// explicit id list is unbounded. (deep audit 2026-09-06, F10)
		const ids = Array.from({ length: 1001 }, (_, i) => `id-${i}`)
		const res = await postJson(appWith(fetchRoutes), "/fetch/ns", { ids })
		expect(res.status).toBe(200)
		const json = (await res.json()) as { result: Array<{ id: string } | null> }
		expect(json.result).toHaveLength(1001)
		expect(json.result[1000]).toEqual({ id: "id-1000" })
	})

	test("delete accepts 1001 ids", async () => {
		const ids = Array.from({ length: 1001 }, (_, i) => `id-${i}`)
		const res = await postJson(appWith(deleteRoutes), "/delete/ns", { ids })
		expect(res.status).toBe(200)
		const json = (await res.json()) as Envelope
		expect(json.result?.deleted).toBe(1001)
	})
})

describe("scan iteration cap fails loudly on every path", () => {
	// A truncated enumeration reported as success let reset/delete claim
	// completion while matching keys survived — range already threw, these
	// paths silently broke. (deep audit 2026-09-06, F3)
	const endless = async (): Promise<[string, string[]]> => ["9", []]

	test("delete by prefix aborts with 400", async () => {
		scanImpl = endless
		const res = await postJson(appWith(deleteRoutes), "/delete/ns", { prefix: "a" })
		expect(res.status).toBe(400)
		const json = (await res.json()) as Envelope
		expect(json.error).toContain("scanable key limit")
	})

	test("delete by filter aborts with 400", async () => {
		scanImpl = endless
		const res = await postJson(appWith(deleteRoutes), "/delete/ns", { filter: "x > 1" })
		expect(res.status).toBe(400)
	})

	test("fetch by prefix aborts with 400", async () => {
		scanImpl = endless
		const res = await postJson(appWith(fetchRoutes), "/fetch/ns", { prefix: "a" })
		expect(res.status).toBe(400)
	})

	test("namespace reset aborts with 400", async () => {
		scanImpl = endless
		const res = await postJson(appWith(resetRoutes), "/reset/ns", {})
		expect(res.status).toBe(400)
	})

	test("random sample aborts with 400", async () => {
		scanImpl = endless
		const res = await postJson(appWith(randomRoutes), "/random/ns", {})
		expect(res.status).toBe(400)
	})
})

describe("fetch by prefix", () => {
	test("returns a result object per scan-derived key", async () => {
		scanImpl = async (): Promise<[string, string[]]> => ["0", ["v:ns:doc-1", "v:ns:doc-2"]]
		const res = await postJson(appWith(fetchRoutes), "/fetch/ns", {
			prefix: "doc",
			includeMetadata: true,
		})
		expect(res.status).toBe(200)
		const json = (await res.json()) as { result: Array<{ id: string } | null> }
		expect(json.result.map((v) => v?.id)).toEqual(["doc-1", "doc-2"])
	})
})
