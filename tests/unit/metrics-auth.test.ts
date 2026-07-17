import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { errorHandler } from "../../src/middleware/error-handler"
import {
	assertMetricsAuthorized,
	metricsAuthorizationOk,
} from "../../src/routes/metrics"

describe("metricsAuthorizationOk", () => {
	test("allows all requests when token is unset", () => {
		expect(metricsAuthorizationOk(undefined, undefined)).toBe(true)
		expect(metricsAuthorizationOk("Bearer anything", undefined)).toBe(true)
		expect(metricsAuthorizationOk(undefined, "")).toBe(true)
	})

	test("requires exact Bearer token when configured", () => {
		expect(metricsAuthorizationOk("Bearer scrape-secret", "scrape-secret")).toBe(
			true,
		)
		expect(metricsAuthorizationOk("Bearer wrong", "scrape-secret")).toBe(false)
		expect(metricsAuthorizationOk(undefined, "scrape-secret")).toBe(false)
		expect(metricsAuthorizationOk("scrape-secret", "scrape-secret")).toBe(false)
	})
})

describe("assertMetricsAuthorized + /metrics handler shape", () => {
	test("returns 401 envelope when token required and missing", async () => {
		const app = new Hono()
		app.onError(errorHandler)
		app.get("/metrics", (c) => {
			assertMetricsAuthorized(c.req.header("Authorization"), "scrape-secret")
			return c.text("ok")
		})
		const res = await app.request("/metrics")
		expect(res.status).toBe(401)
		expect(await res.json()).toEqual({ error: "Unauthorized", status: 401 })
	})

	test("returns metrics body when Bearer matches", async () => {
		const app = new Hono()
		app.onError(errorHandler)
		app.get("/metrics", (c) => {
			assertMetricsAuthorized(c.req.header("Authorization"), "scrape-secret")
			return c.text("# HELP demo\n", 200, {
				"Content-Type": "text/plain; version=0.0.4; charset=utf-8",
			})
		})
		const res = await app.request("/metrics", {
			headers: { Authorization: "Bearer scrape-secret" },
		})
		expect(res.status).toBe(200)
		expect(await res.text()).toContain("# HELP")
	})
})
