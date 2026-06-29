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
})
