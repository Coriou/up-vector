import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { config } from "../../src/config"
import { timeoutMiddleware } from "../../src/middleware/timeout"

const original = config.requestTimeout

afterEach(() => {
	config.requestTimeout = original
})

function appWith(handler: () => Promise<unknown>): Hono {
	const app = new Hono()
	app.use("*", timeoutMiddleware)
	app.get("/", async (c) => {
		await handler()
		return c.json({ result: "ok" })
	})
	return app
}

describe("timeoutMiddleware", () => {
	test("returns 504 with the Upstash envelope when the handler exceeds the timeout", async () => {
		config.requestTimeout = 25
		const app = appWith(() => new Promise((r) => setTimeout(r, 200)))
		const res = await app.request("/")
		expect(res.status).toBe(504)
		expect(await res.json()).toEqual({ error: "Request Timeout", status: 504 })
	})

	test("passes through when the handler finishes in time", async () => {
		config.requestTimeout = 1000
		const app = appWith(async () => {})
		const res = await app.request("/")
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ result: "ok" })
	})

	test("disabled (timeout=0) never times out", async () => {
		config.requestTimeout = 0
		const app = appWith(() => new Promise((r) => setTimeout(r, 40)))
		const res = await app.request("/")
		expect(res.status).toBe(200)
	})

	test("late rejection from a timed-out handler never becomes an unhandledRejection", async () => {
		config.requestTimeout = 25
		const { promise: gate, resolve: releaseHandler } = Promise.withResolvers<void>()
		const unhandled: unknown[] = []
		const listener = (reason: unknown) => {
			unhandled.push(reason)
		}
		process.on("unhandledRejection", listener)
		try {
			const app = appWith(async () => {
				await gate
				throw new Error("late boom")
			})
			// The 504 resolves while the handler is parked on the gate, so the
			// handler's rejection is guaranteed to happen after the race.
			const res = await app.request("/")
			expect(res.status).toBe(504)

			releaseHandler()
			// Drain macrotask turns so a pending unhandledRejection would have
			// been emitted by now; no wall-clock waiting involved.
			for (let i = 0; i < 10; i++) {
				await new Promise<void>((resolve) => setImmediate(resolve))
			}
			expect(unhandled).toEqual([])
		} finally {
			process.off("unhandledRejection", listener)
		}
	})
})

test("a command handle acquired before timeout cannot issue a later mutation", async () => {
	const { guardRedisCommands } = await import("../../src/request-context")
	config.requestTimeout = 10
	const { promise, resolve } = Promise.withResolvers<void>()
	const calls: string[] = []
	const redis = guardRedisCommands({
		async scan() {
			await promise
			return ["fresh-key"]
		},
		async del() {
			calls.push("DEL")
		},
	})
	const app = appWith(async () => {
		await redis.scan()
		await redis.del()
	})
	expect((await app.request("/")).status).toBe(504)
	resolve()
	for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r))
	expect(calls).toEqual([])
})
