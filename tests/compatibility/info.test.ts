import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { awaitIndexed, createIndex, randomVector } from "./setup"

const index = createIndex()

describe("SDK: info", () => {
	beforeAll(async () => {
		await index.reset({ all: true })
		await index.upsert([
			{ id: "info_1", vector: randomVector() },
			{ id: "info_2", vector: randomVector() },
			{ id: "info_3", vector: randomVector() },
		])
		await awaitIndexed()
	})

	afterAll(() => index.reset({ all: true }))

	test("should return correct vectorCount", async () => {
		const info = await index.info()
		expect(info.vectorCount).toBe(3)
	})

	test("should return correct dimension", async () => {
		const info = await index.info()
		expect(info.dimension).toBe(384)
	})

	test("should return COSINE similarity function", async () => {
		const info = await index.info()
		expect(info.similarityFunction).toBe("COSINE")
	})

	test("should return pendingVectorCount as 0", async () => {
		const info = await index.info()
		expect(info.pendingVectorCount).toBe(0)
	})

	test("should include namespace breakdown", async () => {
		const info = await index.info()
		expect(info.namespaces).toBeDefined()
		expect(info.namespaces[""]).toBeDefined()
		expect(info.namespaces[""].vectorCount).toBe(3)
	})
})
