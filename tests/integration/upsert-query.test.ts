import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { api, resetAll } from "./setup"

describe("upsert + query", () => {
	beforeAll(async () => {
		await resetAll()
		await api("POST", "/upsert", [
			{ id: "a", vector: [1, 0, 0], metadata: { label: "x-axis" } },
			{ id: "b", vector: [0, 1, 0], metadata: { label: "y-axis" } },
			{ id: "c", vector: [0, 0, 1], metadata: { label: "z-axis" } },
			{ id: "d", vector: [0.9, 0.1, 0], metadata: { label: "near-x" } },
			{ id: "e", vector: [0.5, 0.5, 0], metadata: { label: "diagonal" } },
		])
		// Wait for RediSearch to index
		await new Promise((r) => setTimeout(r, 500))
	})

	afterAll(resetAll)

	test("returns most similar first", async () => {
		const { data } = await api("POST", "/query", {
			vector: [1, 0, 0],
			topK: 5,
			includeMetadata: true,
		})
		const results = (data as { result: Array<{ id: string; score: number }> }).result
		expect(results.length).toBe(5)
		expect(results[0].id).toBe("a") // exact match
		expect(results[0].score).toBeCloseTo(1.0, 1)
		expect(results[1].id).toBe("d") // near-x
	})

	test("topK limits results", async () => {
		const { data } = await api("POST", "/query", { vector: [1, 0, 0], topK: 2 })
		const results = (data as { result: unknown[] }).result
		expect(results.length).toBe(2)
	})

	test("includeMetadata flag", async () => {
		const { data: withMeta } = await api("POST", "/query", {
			vector: [1, 0, 0],
			topK: 1,
			includeMetadata: true,
		})
		const { data: withoutMeta } = await api("POST", "/query", {
			vector: [1, 0, 0],
			topK: 1,
			includeMetadata: false,
		})
		expect((withMeta as { result: Array<{ metadata?: unknown }> }).result[0].metadata).toBeDefined()
		expect(
			(withoutMeta as { result: Array<{ metadata?: unknown }> }).result[0].metadata,
		).toBeUndefined()
	})

	test("includeVectors flag", async () => {
		const { data } = await api("POST", "/query", {
			vector: [1, 0, 0],
			topK: 1,
			includeVectors: true,
		})
		const vec = (data as { result: Array<{ vector?: number[] }> }).result[0].vector
		expect(vec).toBeDefined()
		expect(vec?.length).toBe(3)
	})

	test("score normalization (COSINE)", async () => {
		const { data } = await api("POST", "/query", { vector: [1, 0, 0], topK: 5 })
		const results = (data as { result: Array<{ score: number }> }).result
		for (const r of results) {
			expect(r.score).toBeGreaterThanOrEqual(0)
			expect(r.score).toBeLessThanOrEqual(1)
		}
	})

	test("query with no index returns empty", async () => {
		const { data } = await api("POST", "/query/nonexistent", {
			vector: [1, 0, 0],
			topK: 5,
		})
		expect((data as { result: unknown[] }).result).toEqual([])
	})
})
