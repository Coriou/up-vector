import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { api, resetAll } from "./setup"

describe("filtered queries", () => {
	beforeAll(async () => {
		await resetAll()
		await api("POST", "/upsert", [
			{
				id: "v1",
				vector: [1, 0, 0],
				metadata: {
					color: "red",
					score: 0.9,
					tags: ["featured", "popular"],
					geo: { continent: "Asia", city: "Istanbul" },
				},
			},
			{
				id: "v2",
				vector: [0, 1, 0],
				metadata: {
					color: "blue",
					score: 0.5,
					tags: ["new"],
					geo: { continent: "Europe", city: "Berlin" },
				},
			},
			{
				id: "v3",
				vector: [0, 0, 1],
				metadata: {
					color: "red",
					score: 0.3,
					tags: ["old"],
					geo: { continent: "Asia", city: "Tokyo" },
				},
			},
			{
				id: "v4",
				vector: [0.5, 0.5, 0],
				metadata: {
					color: "green",
					score: 0.7,
					tags: ["featured"],
					geo: { continent: "Americas", city: "NYC" },
				},
			},
		])
		await new Promise((r) => setTimeout(r, 500))
	})

	afterAll(resetAll)

	test("equality filter", async () => {
		const { data } = await api("POST", "/query", {
			vector: [1, 0, 0],
			topK: 10,
			filter: "color = 'red'",
			includeMetadata: true,
		})
		const results = (data as { result: Array<{ metadata: { color: string } }> }).result
		expect(results.length).toBe(2)
		for (const r of results) expect(r.metadata.color).toBe("red")
	})

	test("numeric comparison filter", async () => {
		const { data } = await api("POST", "/query", {
			vector: [1, 0, 0],
			topK: 10,
			filter: "score >= 0.5",
			includeMetadata: true,
		})
		const results = (data as { result: Array<{ metadata: { score: number } }> }).result
		for (const r of results) expect(r.metadata.score).toBeGreaterThanOrEqual(0.5)
	})

	test("CONTAINS filter", async () => {
		const { data } = await api("POST", "/query", {
			vector: [1, 0, 0],
			topK: 10,
			filter: "tags CONTAINS 'featured'",
			includeMetadata: true,
		})
		const results = (data as { result: Array<{ id: string }> }).result
		const ids = results.map((r) => r.id).sort()
		expect(ids).toEqual(["v1", "v4"])
	})

	test("dot notation filter", async () => {
		const { data } = await api("POST", "/query", {
			vector: [1, 0, 0],
			topK: 10,
			filter: "geo.continent = 'Asia'",
			includeMetadata: true,
		})
		const results = (data as { result: Array<{ id: string }> }).result
		const ids = results.map((r) => r.id).sort()
		expect(ids).toEqual(["v1", "v3"])
	})

	test("IN filter", async () => {
		const { data } = await api("POST", "/query", {
			vector: [1, 0, 0],
			topK: 10,
			filter: "color IN ('red', 'green')",
			includeMetadata: true,
		})
		const results = (data as { result: Array<{ id: string }> }).result
		expect(results.length).toBe(3) // v1, v3, v4
	})

	test("compound AND/OR filter", async () => {
		const { data } = await api("POST", "/query", {
			vector: [1, 0, 0],
			topK: 10,
			filter: "color = 'red' AND score >= 0.5",
			includeMetadata: true,
		})
		const results = (data as { result: Array<{ id: string }> }).result
		expect(results.length).toBe(1)
		expect(results[0].id).toBe("v1")
	})

	test("GLOB filter", async () => {
		const { data } = await api("POST", "/query", {
			vector: [1, 0, 0],
			topK: 10,
			filter: "geo.city GLOB '*o*'",
			includeMetadata: true,
		})
		const results = (data as { result: Array<{ id: string }> }).result
		const ids = results.map((r) => r.id).sort()
		expect(ids).toEqual(["v3"]) // Tokyo
	})

	test("HAS FIELD filter", async () => {
		const { data } = await api("POST", "/query", {
			vector: [1, 0, 0],
			topK: 10,
			filter: "HAS FIELD geo",
			includeMetadata: true,
		})
		const results = (data as { result: unknown[] }).result
		expect(results.length).toBe(4) // all have geo
	})

	test("filter that matches nothing returns empty", async () => {
		const { data } = await api("POST", "/query", {
			vector: [1, 0, 0],
			topK: 10,
			filter: "color = 'purple'",
		})
		expect((data as { result: unknown[] }).result).toEqual([])
	})

	test("HAS NOT FIELD matches a vector with no metadata at all", async () => {
		// Regression: query.ts used to skip candidates with missing metadata
		// before consulting the filter. `HAS NOT FIELD x` must *match* a
		// vector that has no metadata.
		await api("POST", "/upsert/has-not-ns", [
			{ id: "with-meta", vector: [1, 0, 0], metadata: { color: "red" } },
			{ id: "no-meta", vector: [0.9, 0.1, 0] },
		])
		await new Promise((r) => setTimeout(r, 500))

		const { data } = await api("POST", "/query/has-not-ns", {
			vector: [1, 0, 0],
			topK: 10,
			filter: "HAS NOT FIELD color",
			includeMetadata: true,
		})
		const ids = (data as { result: Array<{ id: string }> }).result.map((r) => r.id).sort()
		expect(ids).toContain("no-meta")
		expect(ids).not.toContain("with-meta")

		await api("POST", "/reset/has-not-ns")
	})
})
