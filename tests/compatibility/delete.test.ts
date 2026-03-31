import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createIndex, randomID, randomVector } from "./setup"

const index = createIndex()

describe("SDK: delete", () => {
	beforeAll(() => index.reset({ all: true }))
	afterAll(() => index.reset({ all: true }))

	test("should delete single ID", async () => {
		const id = randomID()
		await index.upsert({ id, vector: randomVector() })
		const result = await index.delete(id)
		expect(result).toEqual({ deleted: 1 })
		const [fetched] = await index.fetch([id])
		expect(fetched).toBeNull()
	})

	test("should delete array of IDs", async () => {
		const ids = [randomID(), randomID()]
		await index.upsert(ids.map((id) => ({ id, vector: randomVector() })))
		const result = await index.delete(ids)
		expect(result).toEqual({ deleted: 2 })
	})

	test("should delete by prefix", async () => {
		const prefix = `delpfx_${Date.now()}_`
		const ids = [`${prefix}a`, `${prefix}b`, `${prefix}c`]
		await index.upsert(ids.map((id) => ({ id, vector: randomVector() })))
		const result = await index.delete({ prefix })
		expect(result.deleted).toBe(3)
	})

	test("should delete by filter", async () => {
		const ids = [randomID(), randomID(), randomID()]
		await index.upsert([
			{ id: ids[0], vector: randomVector(), metadata: { status: "active" } },
			{ id: ids[1], vector: randomVector(), metadata: { status: "archived" } },
			{ id: ids[2], vector: randomVector(), metadata: { status: "active" } },
		])
		const result = await index.delete({ filter: "status = 'archived'" })
		expect(result.deleted).toBe(1)

		const fetched = await index.fetch(ids)
		expect(fetched[0]).not.toBeNull()
		expect(fetched[1]).toBeNull()
		expect(fetched[2]).not.toBeNull()
	})

	test("should delete in namespace by prefix", async () => {
		const ns = index.namespace("delete-ns")
		const prefix = `nsdel_${Date.now()}_`
		await ns.upsert([
			{ id: `${prefix}1`, vector: randomVector() },
			{ id: `${prefix}2`, vector: randomVector() },
		])
		const result = await ns.delete({ prefix })
		expect(result.deleted).toBe(2)
		await ns.reset()
	})

	test("should return deleted:0 for already-deleted IDs", async () => {
		const id = randomID()
		await index.upsert({ id, vector: randomVector() })
		await index.delete(id)
		const result = await index.delete(id)
		expect(result.deleted).toBe(0)
	})
})
