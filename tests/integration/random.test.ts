import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { api, resetAll } from "./setup"

describe("random vector", () => {
	beforeAll(async () => {
		await resetAll()
		await api("POST", "/upsert", [
			{ id: "rnd-a", vector: [1, 0, 0] },
			{ id: "rnd-b", vector: [0, 1, 0] },
		])
		await api("POST", "/upsert/rnd-ns", { id: "rnd-ns-a", vector: [0, 0, 1] })
	})

	afterAll(resetAll)

	test("GET /random returns a dense vector from the default namespace", async () => {
		const { data } = await api("GET", "/random")
		const result = (data as { result: { id: string; vector: number[] } }).result
		expect(["rnd-a", "rnd-b"]).toContain(result.id)
		expect(result.vector.length).toBe(3)
	})

	test("POST /random works for SDK-style clients and namespaces", async () => {
		const { data } = await api("POST", "/random/rnd-ns")
		const result = (data as { result: { id: string; vector: number[] } }).result
		expect(result.id).toBe("rnd-ns-a")
		expect(result.vector).toEqual([0, 0, 1])
	})

	test("empty namespace returns null", async () => {
		const { data } = await api("GET", "/random/empty-random-ns")
		expect((data as { result: null }).result).toBeNull()
	})
})
