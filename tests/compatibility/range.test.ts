import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createIndex, randomVector } from "./setup"

const index = createIndex()

describe("SDK: range", () => {
	beforeAll(async () => {
		await index.reset({ all: true })
		// Upsert 10 vectors with known IDs
		await index.upsert(
			Array.from({ length: 10 }, (_, i) => ({
				id: `range_${String(i).padStart(2, "0")}`,
				vector: randomVector(),
				metadata: { idx: i },
			})),
		)
	})

	afterAll(() => index.reset({ all: true }))

	test("should paginate through all records", async () => {
		const allVectors: string[] = []
		let cursor = "0"
		do {
			const page = await index.range({ cursor, limit: 3, includeMetadata: true })
			for (const v of page.vectors) {
				allVectors.push(v.id)
			}
			cursor = page.nextCursor
		} while (cursor !== "" && cursor !== "0")
		expect(allVectors.length).toBe(10)
	})

	test("should include metadata when requested", async () => {
		const page = await index.range({ cursor: "0", limit: 5, includeMetadata: true })
		for (const v of page.vectors) {
			expect(v.metadata).toBeDefined()
		}
	})

	test("should paginate with prefix", async () => {
		const page = await index.range({ cursor: "0", limit: 100, prefix: "range_0" })
		// range_00 through range_09 match "range_0" prefix
		expect(page.vectors.length).toBeGreaterThanOrEqual(1)
		for (const v of page.vectors) {
			expect(v.id.startsWith("range_0")).toBe(true)
		}
	})

	test("should paginate in namespace", async () => {
		const ns = index.namespace("range-ns")
		await ns.upsert([
			{ id: "rns_1", vector: randomVector() },
			{ id: "rns_2", vector: randomVector() },
		])
		const page = await ns.range({ cursor: "0", limit: 10 })
		expect(page.vectors.length).toBe(2)
		await ns.reset()
	})
})
