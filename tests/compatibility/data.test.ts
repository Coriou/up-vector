import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { awaitIndexed, createIndex } from "./setup"

const index = createIndex()

describe("SDK: data embedding endpoints", () => {
	beforeAll(async () => {
		await index.reset({ all: true })
	})

	afterAll(() => index.reset({ all: true }))

	test("upsert({ data }) and query({ data }) work through the current SDK", async () => {
		await index.upsert([
			{
				id: "sdk-data-alpha",
				data: "alpha beta sdk chunk",
				metadata: { title: "Alpha SDK" },
			},
			{
				id: "sdk-data-gamma",
				data: "gamma delta sdk chunk",
				metadata: { title: "Gamma SDK" },
			},
		])
		await awaitIndexed()

		const results = await index.query({
			data: "alpha beta sdk chunk",
			topK: 2,
			includeMetadata: true,
			includeData: true,
			includeVectors: true,
		})

		expect(results[0].id).toBe("sdk-data-alpha")
		expect(results[0].metadata).toEqual({ title: "Alpha SDK" })
		expect(results[0].data).toBe("alpha beta sdk chunk")
		expect(results[0].vector?.length).toBe(8)
	})

	test("queryMany([{ data }]) normalizes SDK results", async () => {
		const results = await index.queryMany([
			{ data: "alpha beta sdk chunk", topK: 1 },
			{ data: "gamma delta sdk chunk", topK: 1 },
		])

		expect(results.length).toBe(2)
		expect(results[0][0].id).toBe("sdk-data-alpha")
		expect(results[1][0].id).toBe("sdk-data-gamma")
	})

	test("namespace upsert({ data }) and query({ data }) are isolated", async () => {
		const ns = index.namespace("sdk-data-ns")
		await ns.upsert({
			id: "ns-data",
			data: "namespaced raw text",
			metadata: { ns: true },
		})
		await awaitIndexed()

		const namespaced = await ns.query({
			data: "namespaced raw text",
			topK: 1,
			includeMetadata: true,
			includeData: true,
		})
		const root = await index.query({
			data: "namespaced raw text",
			topK: 5,
		})

		expect(namespaced[0].id).toBe("ns-data")
		expect(namespaced[0].metadata).toEqual({ ns: true })
		expect(namespaced[0].data).toBe("namespaced raw text")
		expect(root.some((result) => result.id === "ns-data")).toBe(false)

		await ns.reset()
	})
})
