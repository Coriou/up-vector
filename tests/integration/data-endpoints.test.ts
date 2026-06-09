import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { api, resetAll } from "./setup"

describe("data embedding endpoints", () => {
	beforeAll(resetAll)
	afterAll(resetAll)

	test("POST /upsert-data stores raw text data and /query-data returns ordinary query results", async () => {
		await api("POST", "/upsert-data/rag", [
			{
				id: "doc-alpha",
				data: "alpha beta retrieval chunk",
				metadata: { title: "Alpha" },
			},
			{
				id: "doc-gamma",
				data: "gamma delta unrelated chunk",
				metadata: { title: "Gamma" },
			},
		])
		await new Promise((r) => setTimeout(r, 500))

		const { data } = await api("POST", "/query-data/rag", {
			data: "alpha beta retrieval chunk",
			topK: 2,
			includeMetadata: true,
			includeData: true,
			includeVectors: true,
		})
		const results = (
			data as {
				result: Array<{
					id: string
					metadata?: { title: string }
					data?: string
					vector?: number[]
				}>
			}
		).result

		expect(results[0].id).toBe("doc-alpha")
		expect(results[0].metadata).toEqual({ title: "Alpha" })
		expect(results[0].data).toBe("alpha beta retrieval chunk")
		expect(results[0].vector?.length).toBe(8)
	})

	test("single-item query-data batch returns flat query shape", async () => {
		const { data } = await api("POST", "/query-data/rag", [
			{ data: "alpha beta retrieval chunk", topK: 1 },
		])
		const results = (data as { result: Array<{ id: string }> }).result

		expect(Array.isArray(results)).toBe(true)
		expect(Array.isArray(results[0])).toBe(false)
		expect(results[0].id).toBe("doc-alpha")
	})

	test("multi-query query-data batch returns nested query shape", async () => {
		const { data } = await api("POST", "/query-data/rag", [
			{ data: "alpha beta retrieval chunk", topK: 1 },
			{ data: "gamma delta unrelated chunk", topK: 1 },
		])
		const results = (data as { result: Array<Array<{ id: string }>> }).result

		expect(results.length).toBe(2)
		expect(results[0][0].id).toBe("doc-alpha")
		expect(results[1][0].id).toBe("doc-gamma")
	})

	test("fetch includes data written by upsert-data", async () => {
		const { data } = await api("POST", "/fetch/rag", {
			ids: ["doc-alpha"],
			includeData: true,
			includeVectors: true,
		})
		const [doc] = (data as { result: Array<{ data: string; vector: number[] }> }).result

		expect(doc.data).toBe("alpha beta retrieval chunk")
		expect(doc.vector.length).toBe(8)
	})

	test("upsert-data validates embedding dimension against existing namespace dimension", async () => {
		await api("POST", "/upsert/upsert-data-dim", { id: "dense", vector: [1, 0] })

		const { status, data } = await api("POST", "/upsert-data/upsert-data-dim", {
			id: "text",
			data: "text that embeds to eight dimensions",
		})

		expect(status).toBe(400)
		expect((data as { error: string }).error).toContain("Dimension mismatch")
	})

	test("query-data validates embedding dimension against existing namespace dimension", async () => {
		const { status, data } = await api("POST", "/query-data/upsert-data-dim", {
			data: "text that embeds to eight dimensions",
			topK: 1,
		})

		expect(status).toBe(400)
		expect((data as { error: string }).error).toContain("Dimension mismatch")
	})

	test("rejects malformed upsert-data payloads", async () => {
		const { status, data } = await api("POST", "/upsert-data/rag", {
			id: "missing-data",
		})

		expect(status).toBe(400)
		expect((data as { error: string }).error).toContain("Invalid input")
	})

	test("resumable query endpoints return explicit unsupported errors", async () => {
		const { status, data } = await api("POST", "/resumable-query", {
			vector: [1, 0, 0],
			topK: 1,
		})

		expect(status).toBe(501)
		expect((data as { error: string }).error).toContain("not supported")
	})
})
