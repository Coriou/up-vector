import { describe, expect, test } from "bun:test"
import { createIndex, randomID, randomVector } from "./setup"

const index = createIndex()

describe("SDK: reset", () => {
	test("should reset default namespace", async () => {
		const id = randomID()
		await index.upsert({ id, vector: randomVector() })
		await index.reset()
		const page = await index.range({ cursor: "0", limit: 10 })
		expect(page.vectors.length).toBe(0)
	})

	test("should reset specific namespace", async () => {
		const namespace = `reset-test-ns-${randomID()}`
		const ns = index.namespace(namespace)
		await ns.upsert({ id: randomID(), vector: randomVector() })
		await ns.reset()
		const page = await ns.range({ cursor: "0", limit: 10 })
		expect(page.vectors.length).toBe(0)

		const namespaces = await index.listNamespaces()
		expect(namespaces).toContain(namespace)
		await index.deleteNamespace(namespace)
	})

	test("should reset all namespaces", async () => {
		await index.upsert({ id: randomID(), vector: randomVector() })
		const namespace = `reset-all-ns-${randomID()}`
		const ns = index.namespace(namespace)
		await ns.upsert({ id: randomID(), vector: randomVector() })

		await index.reset({ all: true })

		const defaultPage = await index.range({ cursor: "0", limit: 10 })
		expect(defaultPage.vectors.length).toBe(0)

		const namespacePage = await ns.range({ cursor: "0", limit: 10 })
		expect(namespacePage.vectors.length).toBe(0)

		const namespaces = await index.listNamespaces()
		expect(namespaces).toContain(namespace)
		await index.deleteNamespace(namespace)
	})
})
