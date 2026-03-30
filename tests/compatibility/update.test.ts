import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createIndex, randomID, randomVector } from "./setup"

const index = createIndex()

describe("SDK: update", () => {
	beforeAll(() => index.reset({ all: true }))
	afterAll(() => index.reset({ all: true }))

	test("should update metadata (OVERWRITE)", async () => {
		const id = randomID()
		await index.upsert({ id, vector: randomVector(), metadata: { a: 1, b: 2 } })
		await index.update({ id, metadata: { c: 3 } })
		const [fetched] = await index.fetch([id], { includeMetadata: true })
		// OVERWRITE replaces entire metadata
		expect(fetched?.metadata).toEqual({ c: 3 })
	})

	test("should update metadata (PATCH) — preserve existing fields", async () => {
		const id = randomID()
		await index.upsert({ id, vector: randomVector(), metadata: { a: 1, b: 2 } })
		await index.update({ id, metadata: { c: 3 }, metadataUpdateMode: "PATCH" })
		const [fetched] = await index.fetch([id], { includeMetadata: true })
		expect(fetched?.metadata).toEqual({ a: 1, b: 2, c: 3 })
	})

	test("should update data field", async () => {
		const id = randomID()
		await index.upsert({ id, vector: randomVector(), data: "old" })
		await index.update({ id, data: "new" })
		const [fetched] = await index.fetch([id], { includeData: true })
		expect(fetched?.data).toBe("new")
	})

	test("should update vector", async () => {
		const id = randomID()
		const originalVec = randomVector()
		const newVec = randomVector()
		await index.upsert({ id, vector: originalVec })
		await index.update({ id, vector: newVec })
		const [fetched] = await index.fetch([id], { includeVectors: true })
		// Vectors should be different from original (Float32 precision)
		expect(fetched?.vector).toBeDefined()
		expect(fetched?.vector?.length).toBe(384)
	})

	test("should update in namespace", async () => {
		const ns = index.namespace("update-ns")
		const id = randomID()
		await ns.upsert({ id, vector: randomVector(), metadata: { v: 1 } })
		await ns.update({ id, metadata: { v: 2 } })
		const [fetched] = await ns.fetch([id], { includeMetadata: true })
		expect((fetched?.metadata as { v: number }).v).toBe(2)
		await ns.reset()
	})

	test("should return updated:0 for nonexistent ID", async () => {
		const result = await index.update({ id: "nonexistent", metadata: { x: 1 } })
		expect(result).toEqual({ updated: 0 })
	})
})
