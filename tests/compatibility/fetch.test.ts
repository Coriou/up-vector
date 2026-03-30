import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createIndex, randomID, randomVector } from "./setup"

const index = createIndex()
const ids = { a: randomID(), b: randomID(), c: randomID() }

describe("SDK: fetch", () => {
	beforeAll(async () => {
		await index.reset({ all: true })
		await index.upsert([
			{ id: ids.a, vector: randomVector(), metadata: { color: "red" } },
			{ id: ids.b, vector: randomVector(), metadata: { color: "blue" } },
			{ id: ids.c, vector: randomVector() },
		])
		// Add data fields via update
		await index.update({ id: ids.a, data: "payload-a" })
		await index.update({ id: ids.b, data: "payload-b" })
	})

	afterAll(() => index.reset({ all: true }))

	test("should fetch by IDs", async () => {
		const results = await index.fetch([ids.a, ids.b])
		expect(results.length).toBe(2)
		expect(results[0]?.id).toBe(ids.a)
		expect(results[1]?.id).toBe(ids.b)
	})

	test("should return null for non-existent ID", async () => {
		const results = await index.fetch([ids.a, "nonexistent"])
		expect(results[0]).not.toBeNull()
		expect(results[1]).toBeNull()
	})

	test("should include metadata when requested", async () => {
		const results = await index.fetch([ids.a], { includeMetadata: true })
		expect(results[0]?.metadata).toEqual({ color: "red" })
	})

	test("should include vectors when requested", async () => {
		const results = await index.fetch([ids.a], { includeVectors: true })
		expect(results[0]?.vector).toBeDefined()
		expect(results[0]?.vector?.length).toBe(384)
	})

	test("should include data when requested", async () => {
		const results = await index.fetch([ids.a], { includeData: true })
		expect(results[0]?.data).toBe("payload-a")
	})

	test("should not include data when not requested", async () => {
		const results = await index.fetch([ids.a], { includeData: false })
		expect(results[0]?.data).toBeUndefined()
	})

	test("should fetch by prefix", async () => {
		// IDs start with "test_" from randomID
		const results = await index.fetch({ prefix: "test_" }, { includeMetadata: true })
		expect(results.length).toBeGreaterThanOrEqual(3)
	})

	test("should fetch in namespace", async () => {
		const ns = index.namespace("fetch-ns")
		const id = randomID()
		await ns.upsert({ id, vector: randomVector(), metadata: { x: 1 } })
		const results = await ns.fetch([id], { includeMetadata: true })
		expect(results[0]?.metadata).toEqual({ x: 1 })
		await ns.reset()
	})
})
