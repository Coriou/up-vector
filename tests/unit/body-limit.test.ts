import { describe, expect, test } from "bun:test"
import { config } from "../../src/config"
import { app } from "../../src/server"

describe("body size limit", () => {
	test("rejects an over-limit body with 413 and the Upstash error envelope", async () => {
		// One byte over the configured limit. Hono's bodyLimit rejects on the
		// Content-Length header before any route handler (or Redis) is reached, so
		// this exercises the real middleware wiring without a live backend.
		const tooBig = new Uint8Array(config.maxBodySize + 1)
		const res = await app.request("/upsert", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${config.token}`,
				"Content-Type": "application/json",
			},
			body: tooBig,
		})
		expect(res.status).toBe(413)
		expect(await res.json()).toEqual({ error: "Request body too large", status: 413 })
	})

	test("a body within the limit is not rejected by the size guard", async () => {
		// A small malformed body passes the size guard and is rejected later (for
		// bad JSON / validation), proving the 413 guard didn't fire.
		const res = await app.request("/upsert", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${config.token}`,
				"Content-Type": "application/json",
			},
			body: "{}",
		})
		expect(res.status).not.toBe(413)
	})
})
