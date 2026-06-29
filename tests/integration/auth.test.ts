import { describe, expect, test } from "bun:test"
import { api, BASE_URL } from "./setup"

// The authenticated boundary (Hono bearerAuth) had no end-to-end coverage —
// these lock in that protected routes reject missing/invalid tokens and that
// the public health route needs none.
describe("auth", () => {
	test("missing Authorization header → 401", async () => {
		const res = await fetch(`${BASE_URL}/upsert`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id: "x", vector: [1, 0, 0] }),
		})
		expect(res.status).toBe(401)
	})

	test("wrong bearer token → 401", async () => {
		const res = await fetch(`${BASE_URL}/upsert`, {
			method: "POST",
			headers: {
				Authorization: "Bearer definitely-not-the-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ id: "x", vector: [1, 0, 0] }),
		})
		expect(res.status).toBe(401)
	})

	test("valid bearer token is accepted (not 401)", async () => {
		const { status } = await api("POST", "/upsert/auth-check-ns", {
			id: "ok",
			vector: [1, 0, 0],
		})
		expect(status).not.toBe(401)
		await api("POST", "/reset/auth-check-ns")
	})

	test("the health endpoint requires no auth", async () => {
		const res = await fetch(`${BASE_URL}/health`)
		expect(res.status).toBe(200)
	})
})
