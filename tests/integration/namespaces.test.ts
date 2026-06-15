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

	test("reset namespace preserves the namespace entry", async () => {
		await api("POST", "/upsert/reset-preserve", { id: "reset-preserve-id", vector: [1, 0, 0] })

		await api("POST", "/reset/reset-preserve")

		const { data: namespaces } = await api("GET", "/list-namespaces")
		expect((namespaces as { result: string[] }).result).toContain("reset-preserve")

		const { data: page } = await api("POST", "/range/reset-preserve", {
			cursor: "0",
			limit: 10,
		})
		expect((page as { result: { vectors: unknown[] } }).result.vectors).toEqual([])

		await api("DELETE", "/delete-namespace/reset-preserve")
	})

	test("rename namespace moves vectors and registry entry", async () => {
		await api("POST", "/upsert/old-ns", {
			id: "renamed-id",
			vector: [0, 1, 0],
			metadata: { moved: true },
		})
		await new Promise((r) => setTimeout(r, 500))

		const { data } = await api("POST", "/rename-namespace", {
			namespace: "old-ns",
			newNamespace: "new-ns",
		})
		expect((data as { result: { renamed: boolean } }).result.renamed).toBe(true)

		const { data: namespaces } = await api("GET", "/list-namespaces")
		const listed = (namespaces as { result: string[] }).result
		expect(listed).toContain("new-ns")
		expect(listed).not.toContain("old-ns")

		const { data: oldQuery } = await api("POST", "/query/old-ns", {
			vector: [0, 1, 0],
			topK: 10,
		})
		expect((oldQuery as { result: unknown[] }).result).toEqual([])

		const { data: newQuery } = await api("POST", "/query/new-ns", {
			vector: [0, 1, 0],
			topK: 10,
			includeMetadata: true,
		})
		const results = (newQuery as { result: Array<{ id: string; metadata: { moved: boolean } }> })
			.result
		expect(results[0].id).toBe("renamed-id")
		expect(results[0].metadata.moved).toBe(true)
	})

	test("rename namespace respects deleteExisting flag", async () => {
		await api("POST", "/upsert/rename-src", { id: "src", vector: [1, 0, 0] })
		await api("POST", "/upsert/rename-dst", { id: "dst", vector: [0, 1, 0] })

		const { data: blocked } = await api("POST", "/rename-namespace", {
			namespace: "rename-src",
			newNamespace: "rename-dst",
		})
		expect((blocked as { result: { renamed: boolean } }).result.renamed).toBe(false)

		const { data: replaced } = await api("POST", "/rename-namespace", {
			namespace: "rename-src",
			newNamespace: "rename-dst",
			deleteExisting: true,
		})
		expect((replaced as { result: { renamed: boolean } }).result.renamed).toBe(true)

		const { data: fetched } = await api("POST", "/fetch/rename-dst", {
			ids: ["src", "dst"],
		})
		const vectors = (fetched as { result: Array<{ id: string } | null> }).result
		expect(vectors[0]?.id).toBe("src")
		expect(vectors[1]).toBeNull()
	})

	test("reset all preserves namespace entries while emptying vectors", async () => {
		await api("POST", "/upsert", { id: "tmp", vector: [1, 0, 0] })
		await api("POST", "/upsert/reset-all-a", { id: "tmp-a", vector: [1, 0, 0] })
		await api("POST", "/upsert/reset-all-b", { id: "tmp-b", vector: [0, 1, 0] })

		await api("POST", "/reset?all=true")

		const { data: namespaces } = await api("GET", "/list-namespaces")
		const listed = (namespaces as { result: string[] }).result
		expect(listed).toContain("")
		expect(listed).toContain("reset-all-a")
		expect(listed).toContain("reset-all-b")

		const { data: defaultPage } = await api("POST", "/range", { cursor: "0", limit: 10 })
		const { data: pageA } = await api("POST", "/range/reset-all-a", {
			cursor: "0",
			limit: 10,
		})
		const { data: pageB } = await api("POST", "/range/reset-all-b", {
			cursor: "0",
			limit: 10,
		})
		expect((defaultPage as { result: { vectors: unknown[] } }).result.vectors).toEqual([])
		expect((pageA as { result: { vectors: unknown[] } }).result.vectors).toEqual([])
		expect((pageB as { result: { vectors: unknown[] } }).result.vectors).toEqual([])

		await api("DELETE", "/delete-namespace/reset-all-a")
		await api("DELETE", "/delete-namespace/reset-all-b")
	})
})
