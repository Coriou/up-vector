import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createIndex } from "./setup"

const index = createIndex()

describe("@upstash/vector SDK compatibility", () => {
	beforeAll(async () => {
		await index.reset({ all: true })
	})

	afterAll(async () => {
		await index.reset({ all: true })
	})

	test("upsert single vector", async () => {
		const result = await index.upsert({
			id: "sdk-1",
			vector: [0.1, 0.2, 0.3],
			metadata: { title: "Hello" },
		})
		expect(result).toBe("Success")
	})

	test("upsert batch", async () => {
		const result = await index.upsert([
			{ id: "sdk-2", vector: [0.4, 0.5, 0.6], metadata: { title: "World" } },
			{ id: "sdk-3", vector: [0.7, 0.8, 0.9], metadata: { title: "Test" } },
		])
		expect(result).toBe("Success")
	})

	test("fetch by IDs", async () => {
		const results = await index.fetch(["sdk-1", "sdk-2", "nonexistent"], {
			includeMetadata: true,
			includeVectors: true,
		})
		expect(results.length).toBe(3)
		expect(results[0]?.id).toBe("sdk-1")
		expect(results[0]?.metadata).toEqual({ title: "Hello" })
		expect(results[0]?.vector?.length).toBe(3)
		expect(results[1]?.id).toBe("sdk-2")
		expect(results[2]).toBeNull()
	})

	test("query returns scored results", async () => {
		// Wait for indexing
		await new Promise((r) => setTimeout(r, 500))

		const results = await index.query({
			vector: [0.1, 0.2, 0.3],
			topK: 3,
			includeMetadata: true,
		})
		expect(results.length).toBe(3)
		expect(results[0].id).toBe("sdk-1") // exact match, highest score
		expect(results[0].score).toBeGreaterThan(0.9)
		expect(results[0].metadata).toEqual({ title: "Hello" })
	})

	test("query with filter", async () => {
		const results = await index.query({
			vector: [0.1, 0.2, 0.3],
			topK: 10,
			filter: "title = 'World'",
			includeMetadata: true,
		})
		expect(results.length).toBe(1)
		expect(results[0].id).toBe("sdk-2")
	})

	test("update with metadata patch", async () => {
		await index.update({
			id: "sdk-1",
			metadata: { category: "test" },
			metadataUpdateMode: "PATCH",
		})
		const [fetched] = await index.fetch(["sdk-1"], { includeMetadata: true })
		expect(fetched?.metadata).toEqual({ title: "Hello", category: "test" })
	})

	test("delete by IDs", async () => {
		const result = await index.delete(["sdk-3"])
		expect(result).toEqual({ deleted: 1 })
	})

	test("range pagination", async () => {
		const page = await index.range({
			cursor: 0,
			limit: 10,
			includeMetadata: true,
		})
		expect(page.vectors.length).toBeGreaterThanOrEqual(2)
		for (const v of page.vectors) {
			expect(v.id).toBeTruthy()
		}
	})

	test("info returns stats", async () => {
		const info = await index.info()
		expect(info.dimension).toBe(3)
		expect(info.similarityFunction).toBe("COSINE")
		expect(typeof info.vectorCount).toBe("number")
	})

	test("namespace isolation", async () => {
		const ns = index.namespace("test-ns")
		await ns.upsert({ id: "ns-1", vector: [1, 0, 0] })
		await new Promise((r) => setTimeout(r, 500))

		// Query in namespace
		const nsResults = await ns.query({ vector: [1, 0, 0], topK: 10 })
		expect(nsResults.length).toBe(1)
		expect(nsResults[0].id).toBe("ns-1")

		// Query in default — should not find ns-1
		const defaultResults = await index.query({ vector: [1, 0, 0], topK: 10 })
		const defaultIds = defaultResults.map((r) => r.id)
		expect(defaultIds).not.toContain("ns-1")

		await ns.reset()
	})

	test("reset clears vectors", async () => {
		await index.reset()
		const page = await index.range({ cursor: 0, limit: 10 })
		expect(page.vectors.length).toBe(0)
	})
})
