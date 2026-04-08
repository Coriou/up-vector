import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import { ValidationError } from "../../src/errors"
import { errorHandler } from "../../src/middleware/error-handler"

function makeApp(handler: () => unknown): Hono {
	const app = new Hono()
	app.onError(errorHandler)
	app.get("/", () => {
		const result = handler()
		// If handler returns a value, treat it as success (won't happen in these tests).
		return new Response(JSON.stringify(result), {
			headers: { "content-type": "application/json" },
		})
	})
	return app
}

async function asJson(res: Response): Promise<{ status: number; body: { error?: string } }> {
	const body = (await res.json()) as { error?: string }
	return { status: res.status, body }
}

describe("errorHandler", () => {
	test("ValidationError → 400 with the message verbatim", async () => {
		const app = makeApp(() => {
			throw new ValidationError("Bad namespace")
		})
		const res = await app.request("/")
		const { status, body } = await asJson(res)
		expect(status).toBe(400)
		expect(body.error).toBe("Bad namespace")
	})

	test("ZodError → 400 with concatenated messages", async () => {
		const schema = z.object({ x: z.string() })
		const app = makeApp(() => {
			schema.parse({})
			return null
		})
		const res = await app.request("/")
		const { status, body } = await asJson(res)
		expect(status).toBe(400)
		expect(body.error).toBeTruthy()
	})

	test("SyntaxError → 400 'Invalid JSON body'", async () => {
		const app = makeApp(() => {
			throw new SyntaxError("Unexpected token < in JSON")
		})
		const res = await app.request("/")
		const { status, body } = await asJson(res)
		expect(status).toBe(400)
		expect(body.error).toBe("Invalid JSON body")
	})

	test("HTTPException with empty message uses status text fallback (401)", async () => {
		// hono/bearer-auth throws HTTPException without a message — we used to
		// hardcode "Unauthorized" for every empty-message HTTPException, which
		// produced misleading bodies for 4xx other than 401.
		const app = makeApp(() => {
			throw new HTTPException(401)
		})
		const res = await app.request("/")
		const { status, body } = await asJson(res)
		expect(status).toBe(401)
		expect(body.error).toBe("Unauthorized")
	})

	test("HTTPException with empty message uses status text fallback (400)", async () => {
		const app = makeApp(() => {
			throw new HTTPException(400)
		})
		const res = await app.request("/")
		const { status, body } = await asJson(res)
		expect(status).toBe(400)
		expect(body.error).toBe("Bad Request")
	})

	test("HTTPException with explicit message preserves it", async () => {
		const app = makeApp(() => {
			throw new HTTPException(403, { message: "go away" })
		})
		const res = await app.request("/")
		const { status, body } = await asJson(res)
		expect(status).toBe(403)
		expect(body.error).toBe("go away")
	})

	test("Generic Error → 500 'Internal Server Error' (no leak)", async () => {
		// A bare Error must NOT leak through as a 400 just because its message
		// happens to contain a validator phrase. This was the failure mode of
		// the previous substring-matching error handler.
		const app = makeApp(() => {
			throw new Error("Expected response from upstream — must not contain server details")
		})
		const res = await app.request("/")
		const { status, body } = await asJson(res)
		expect(status).toBe(500)
		expect(body.error).toBe("Internal Server Error")
	})
})
