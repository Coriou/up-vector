import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { api, resetAll } from "./setup"

describe("namespaces", () => {
	beforeAll(resetAll)
	afterAll(resetAll)

	test("cross-namespace isolation", async () => {
		// Upsert to default and named namespace
		await api("POST", "/upsert", { id: "ns-1", vector: [1, 0, 0] })
		await api("POST", "/upsert/prod", { id: "ns-2", vector: [0, 1, 0] })
		await new Promise((r) => setTimeout(r, 500))

		// Query default — should only find ns-1
		const { data: defaultRes } = await api("POST", "/query", { vector: [1, 0, 0], topK: 10 })
		const defaultIds = (defaultRes as { result: Array<{ id: string }> }).result.map((r) => r.id)
		expect(defaultIds).toContain("ns-1")
		expect(defaultIds).not.toContain("ns-2")

		// Query prod — should only find ns-2
		const { data: prodRes } = await api("POST", "/query/prod", { vector: [0, 1, 0], topK: 10 })
		const prodIds = (prodRes as { result: Array<{ id: string }> }).result.map((r) => r.id)
		expect(prodIds).toContain("ns-2")
		expect(prodIds).not.toContain("ns-1")
	})

	test("list namespaces", async () => {
		const { data } = await api("GET", "/list-namespaces")
		const ns = (data as { result: string[] }).result.sort()
		expect(ns).toContain("")
		expect(ns).toContain("prod")
	})

	test("delete namespace", async () => {
		await api("DELETE", "/delete-namespace/prod")
		const { data } = await api("GET", "/list-namespaces")
		expect((data as { result: string[] }).result).not.toContain("prod")
	})

	test("reset all", async () => {
		await api("POST", "/upsert", { id: "tmp", vector: [1, 0, 0] })
		await api("POST", "/reset?all=true")
		const { data } = await api("GET", "/list-namespaces")
		// After reset all, registry is cleared
		expect((data as { result: string[] }).result.length).toBe(0)
	})
})
