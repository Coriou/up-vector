import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { awaitIndexed, createIndex, randomID, randomVector } from "./setup"

const index = createIndex()

describe("SDK: namespaces", () => {
	beforeAll(() => index.reset({ all: true }))
	afterAll(() => index.reset({ all: true }))

	test("should isolate namespaces — upsert and query", async () => {
		const nsA = index.namespace("ns-a")
		const nsB = index.namespace("ns-b")
		const vecA = randomVector()
		const vecB = randomVector()

		await nsA.upsert({ id: "iso-1", vector: vecA })
		await nsB.upsert({ id: "iso-2", vector: vecB })
		await awaitIndexed()

		const resultsA = await nsA.query({ vector: vecA, topK: 10 })
		expect(resultsA.map((r) => r.id)).toContain("iso-1")
		expect(resultsA.map((r) => r.id)).not.toContain("iso-2")

		const resultsB = await nsB.query({ vector: vecB, topK: 10 })
		expect(resultsB.map((r) => r.id)).toContain("iso-2")
		expect(resultsB.map((r) => r.id)).not.toContain("iso-1")

		await nsA.reset()
		await nsB.reset()
	})

	test("should update in namespace", async () => {
		const ns = index.namespace("ns-update")
		const id = randomID()
		await ns.upsert({ id, vector: randomVector(), metadata: { v: 1 } })
		await ns.update({ id, metadata: { v: 2 } })
		const [fetched] = await ns.fetch([id], { includeMetadata: true })
		expect((fetched?.metadata as { v: number }).v).toBe(2)
		await ns.reset()
	})

	test("should list namespaces", async () => {
		await index.upsert({ id: randomID(), vector: randomVector() })
		const ns = index.namespace("listed-ns")
		await ns.upsert({ id: randomID(), vector: randomVector() })

		const namespaces = await index.listNamespaces()
		expect(namespaces).toContain("")
		expect(namespaces).toContain("listed-ns")

		await ns.reset()
	})

	test("should delete namespace", async () => {
		const ns = index.namespace("to-delete")
		await ns.upsert({ id: randomID(), vector: randomVector() })
		await index.deleteNamespace("to-delete")

		const namespaces = await index.listNamespaces()
		expect(namespaces).not.toContain("to-delete")
	})

	test("should reset namespace without affecting others", async () => {
		const id1 = randomID()
		const id2 = randomID()
		await index.upsert({ id: id1, vector: randomVector() })
		const ns = index.namespace("ns-reset-iso")
		await ns.upsert({ id: id2, vector: randomVector() })

		await ns.reset()

		// Default namespace should still have its vector
		const [defaultVec] = await index.fetch([id1])
		expect(defaultVec).not.toBeNull()

		// Namespace should be empty
		const page = await ns.range({ cursor: "0", limit: 10 })
		expect(page.vectors.length).toBe(0)
	})
})
