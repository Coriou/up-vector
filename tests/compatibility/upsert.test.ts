import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { awaitIndexed, createIndex, randomID, randomVector } from "./setup"

const index = createIndex()

describe("SDK: upsert", () => {
	beforeAll(() => index.reset({ all: true }))
	afterAll(() => index.reset({ all: true }))

	test("should upsert single vector", async () => {
		const result = await index.upsert({ id: randomID(), vector: randomVector() })
		expect(result).toBe("Success")
	})

	test("should upsert with metadata", async () => {
		const id = randomID()
		await index.upsert({
			id,
			vector: randomVector(),
			metadata: { type: "animal", name: "cat", population: 1000 },
		})
		const [fetched] = await index.fetch([id], { includeMetadata: true })
		expect(fetched?.metadata).toEqual({ type: "animal", name: "cat", population: 1000 })
	})

	test("should upsert with data field", async () => {
		const id = randomID()
		await index.upsert({ id, vector: randomVector(), data: "some raw payload" })
		const [fetched] = await index.fetch([id], { includeData: true })
		expect(fetched?.data).toBe("some raw payload")
	})

	test("should upsert bulk with string IDs", async () => {
		const ids = [randomID(), randomID(), randomID()]
		const result = await index.upsert(ids.map((id) => ({ id, vector: randomVector() })))
		expect(result).toBe("Success")
		const fetched = await index.fetch(ids)
		expect(fetched.length).toBe(3)
		for (const v of fetched) expect(v).not.toBeNull()
	})

	test("should overwrite existing vector on re-upsert", async () => {
		const id = randomID()
		await index.upsert({ id, vector: randomVector(), metadata: { v: 1 } })
		await index.upsert({ id, vector: randomVector(), metadata: { v: 2 } })
		const [fetched] = await index.fetch([id], { includeMetadata: true })
		expect((fetched?.metadata as { v: number }).v).toBe(2)
	})

	test("should upsert to namespace", async () => {
		const ns = index.namespace("upsert-ns")
		const id = randomID()
		await ns.upsert({ id, vector: randomVector() })
		const [fetched] = await ns.fetch([id])
		expect(fetched).not.toBeNull()
		await ns.reset()
	})
})
