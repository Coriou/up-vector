import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { loggerMiddleware, sanitizeIncomingRequestId } from "../../src/middleware/logger"

function makeApp(): Hono {
	const app = new Hono()
	app.use(loggerMiddleware)
	app.get("/", (c) => c.text("ok"))
	return app
}

describe("loggerMiddleware request-id handling", () => {
	test("generates a UUID when no header is sent", async () => {
		const res = await makeApp().request("/")
		const id = res.headers.get("X-Request-ID")
		expect(id).toBeTruthy()
		// crypto.randomUUID() shape: 8-4-4-4-12 hex
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
	})

	test("forwards a well-formed client request id", async () => {
		const incoming = "trace-abc-123_def.456"
		const res = await makeApp().request("/", {
			headers: { "x-request-id": incoming },
		})
		expect(res.headers.get("X-Request-ID")).toBe(incoming)
	})

	test("rejects overly long request id and falls back to UUID", async () => {
		const huge = "x".repeat(200)
		const res = await makeApp().request("/", {
			headers: { "x-request-id": huge },
		})
		expect(res.headers.get("X-Request-ID")).not.toBe(huge)
	})

	test("rejects request id with disallowed punctuation and falls back to UUID", async () => {
		const res = await makeApp().request("/", {
			headers: { "x-request-id": "abc<script>" },
		})
		expect(res.headers.get("X-Request-ID")).not.toBe("abc<script>")
	})
})

describe("sanitizeIncomingRequestId", () => {
	// Direct unit tests for the sanitizer — the standard fetch() implementation
	// strips control characters from header values before they reach the
	// middleware, so we can't reach this branch through HTTP. We still want
	// belt-and-braces protection in case someone routes around fetch.
	test("accepts well-formed ids", () => {
		expect(sanitizeIncomingRequestId("trace-1.2_abc")).toBe("trace-1.2_abc")
	})

	test("rejects empty / undefined input", () => {
		expect(sanitizeIncomingRequestId("")).toBeUndefined()
		expect(sanitizeIncomingRequestId(undefined)).toBeUndefined()
	})

	test("rejects control characters (defence in depth)", () => {
		expect(sanitizeIncomingRequestId("abc\nINJECTED")).toBeUndefined()
		expect(sanitizeIncomingRequestId("abc\x00ZERO")).toBeUndefined()
		expect(sanitizeIncomingRequestId("abc\x07BELL")).toBeUndefined()
	})

	test("rejects punctuation that could break log/header parsing", () => {
		expect(sanitizeIncomingRequestId("a<b")).toBeUndefined()
		expect(sanitizeIncomingRequestId('a"b')).toBeUndefined()
		expect(sanitizeIncomingRequestId("a b")).toBeUndefined()
	})

	test("rejects ids longer than 128 chars", () => {
		expect(sanitizeIncomingRequestId("x".repeat(129))).toBeUndefined()
	})

	test("accepts ids at exactly the cap", () => {
		const cap = "x".repeat(128)
		expect(sanitizeIncomingRequestId(cap)).toBe(cap)
	})
})
