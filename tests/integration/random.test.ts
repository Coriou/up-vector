import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { api, resetAll } from "./setup"

describe("random vector", () => {
	beforeAll(async () => {
		await resetAll()
		await api("POST", "/upsert", [
			{
				id: "rnd-a",
				vector: [1, 0, 0],
				metadata: { color: "red" },
				data: "alpha",
			},
			{
				id: "rnd-b",
				vector: [0, 1, 0],
				metadata: { color: "blue" },
				data: "beta",
			},
		])
		await api("POST", "/upsert/rnd-ns", {
			id: "rnd-ns-a",
			vector: [0, 0, 1],
			metadata: { ns: true },
			data: "ns-data",
		})
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

	test("defaults include vectors and omit metadata/data", async () => {
		const { data } = await api("GET", "/random")
		const result = (data as { result: Record<string, unknown> }).result
		expect(result.vector).toBeDefined()
		expect(result.metadata).toBeUndefined()
		expect(result.data).toBeUndefined()
	})

	test("GET honors includeMetadata and includeData query flags", async () => {
		const { data } = await api("GET", "/random?includeMetadata=true&includeData=true")
		const result = (
			data as {
				result: { id: string; metadata?: { color: string }; data?: string }
			}
		).result
		expect(result.metadata?.color).toBeDefined()
		expect(result.data).toBeDefined()
	})

	test("POST can omit vectors when includeVectors is false", async () => {
		const { data } = await api("POST", "/random/rnd-ns", {
			includeVectors: false,
			includeMetadata: true,
			includeData: true,
		})
		const result = (
			data as {
				result: {
					id: string
					vector?: number[]
					metadata?: { ns: boolean }
					data?: string
				}
			}
		).result
		expect(result.id).toBe("rnd-ns-a")
		expect(result.vector).toBeUndefined()
		expect(result.metadata).toEqual({ ns: true })
		expect(result.data).toBe("ns-data")
	})

	test("POST with empty body keeps vector default", async () => {
		const res = await fetch(
			`${process.env.UPVECTOR_TEST_URL ?? "http://localhost:8080"}/random/rnd-ns`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${process.env.UPVECTOR_TOKEN ?? "test-token-123"}`,
					"Content-Type": "application/json",
				},
				body: "",
			},
		)
		const data = (await res.json()) as { result: { id: string; vector?: number[] } }
		expect(res.status).toBe(200)
		expect(data.result.id).toBe("rnd-ns-a")
		expect(data.result.vector).toEqual([0, 0, 1])
	})
})
