import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { api, resetAll } from "./setup"

describe("CRUD lifecycle", () => {
	beforeAll(resetAll)
	afterAll(resetAll)

	test("upsert → fetch → update → fetch → delete → fetch", async () => {
		// Upsert
		const { data: upsertRes } = await api("POST", "/upsert", {
			id: "crud-1",
			vector: [1, 0, 0],
			metadata: { name: "original" },
			data: "raw-data",
		})
		expect((upsertRes as { result: string }).result).toBe("Success")

		// Fetch
		const { data: fetchRes } = await api("POST", "/fetch", {
			ids: ["crud-1"],
			includeMetadata: true,
			includeVectors: true,
			includeData: true,
		})
		const vec = (
			fetchRes as {
				result: Array<{ id: string; metadata: { name: string }; data: string; vector: number[] }>
			}
		).result[0]
		expect(vec.id).toBe("crud-1")
		expect(vec.metadata.name).toBe("original")
		expect(vec.data).toBe("raw-data")
		expect(vec.vector.length).toBe(3)

		// Update metadata with PATCH
		await api("POST", "/update", {
			id: "crud-1",
			metadata: { category: "test" },
			metadataUpdateMode: "PATCH",
		})

		// Fetch after update
		const { data: fetchRes2 } = await api("POST", "/fetch", {
			ids: ["crud-1"],
			includeMetadata: true,
		})
		const meta = (fetchRes2 as { result: Array<{ metadata: Record<string, unknown> }> }).result[0]
			.metadata
		expect(meta.name).toBe("original") // preserved
		expect(meta.category).toBe("test") // added

		// Delete
		const { data: delRes } = await api("POST", "/delete", { ids: ["crud-1"] })
		expect((delRes as { result: { deleted: number } }).result.deleted).toBe(1)

		// Fetch after delete
		const { data: fetchRes3 } = await api("POST", "/fetch", { ids: ["crud-1"] })
		expect((fetchRes3 as { result: Array<null> }).result[0]).toBeNull()
	})

	test("delete by prefix", async () => {
		await api("POST", "/upsert", [
			{ id: "pfx-a", vector: [1, 0, 0] },
			{ id: "pfx-b", vector: [0, 1, 0] },
			{ id: "other", vector: [0, 0, 1] },
		])
		const { data } = await api("POST", "/delete", { prefix: "pfx-" })
		expect((data as { result: { deleted: number } }).result.deleted).toBe(2)

		const { data: fetchRes } = await api("POST", "/fetch", { ids: ["pfx-a", "pfx-b", "other"] })
		const results = (fetchRes as { result: unknown[] }).result
		expect(results[0]).toBeNull()
		expect(results[1]).toBeNull()
		expect(results[2]).not.toBeNull()
	})

	test("delete by filter", async () => {
		await api("POST", "/upsert", [
			{ id: "df-1", vector: [1, 0, 0], metadata: { status: "active" } },
			{ id: "df-2", vector: [0, 1, 0], metadata: { status: "archived" } },
			{ id: "df-3", vector: [0, 0, 1], metadata: { status: "active" } },
		])
		const { data } = await api("POST", "/delete", { filter: "status = 'archived'" })
		expect((data as { result: { deleted: number } }).result.deleted).toBe(1)

		const { data: fetchRes } = await api("POST", "/fetch", {
			ids: ["df-1", "df-2", "df-3"],
			includeMetadata: true,
		})
		const results = (fetchRes as { result: Array<{ id: string } | null> }).result
		expect(results[0]).not.toBeNull()
		expect(results[1]).toBeNull()
		expect(results[2]).not.toBeNull()
	})

	test("update nonexistent returns 0", async () => {
		const { data } = await api("POST", "/update", { id: "nonexistent", metadata: { x: 1 } })
		expect((data as { result: { updated: number } }).result.updated).toBe(0)
	})

	test("delete by filter HAS NOT FIELD removes vectors with no metadata", async () => {
		// Regression: delete.ts used to skip candidates with no metadata
		// before consulting the filter. HAS NOT FIELD must match them.
		await api("POST", "/upsert/del-has-not", [
			{ id: "with-color", vector: [1, 0, 0], metadata: { color: "red" } },
			{ id: "no-meta", vector: [0.9, 0.1, 0] },
		])

		const { data } = await api("POST", "/delete/del-has-not", {
			filter: "HAS NOT FIELD color",
		})
		expect((data as { result: { deleted: number } }).result.deleted).toBe(1)

		const { data: fetchRes } = await api("POST", "/fetch/del-has-not", {
			ids: ["with-color", "no-meta"],
		})
		const results = (fetchRes as { result: Array<{ id: string } | null> }).result
		expect(results[0]).not.toBeNull()
		expect(results[1]).toBeNull()

		await api("POST", "/reset/del-has-not")
	})

	test("update vector field is atomic with EXISTS check", async () => {
		// Regression: update.ts used to do EXISTS-then-HSET from the application,
		// which left a window where a concurrent delete could let the HSET
		// resurrect a half-formed key (no `vec` field). The new Lua-based
		// implementation rejects updates to non-existent keys atomically.
		const { data: updateMissing } = await api("POST", "/update", {
			id: "definitely-not-here",
			vector: [1, 2, 3],
		})
		expect((updateMissing as { result: { updated: number } }).result.updated).toBe(0)

		// And the missing key must NOT have been resurrected with a partial hash.
		const { data: fetchMissing } = await api("POST", "/fetch", {
			ids: ["definitely-not-here"],
		})
		expect((fetchMissing as { result: Array<unknown | null> }).result[0]).toBeNull()
	})

	test("update preserves the binary vec blob round trip", async () => {
		// The atomic update path uses redis.send("EVAL") with a fresh args array
		// containing both the encoded Buffer and the base64 mirror. Make sure
		// the Buffer survives the trip and a subsequent query against the new
		// vector finds it as the closest match.
		const id = "vec-update-roundtrip"
		await api("POST", "/upsert", { id, vector: [1, 0, 0] })
		await api("POST", "/update", { id, vector: [0, 0, 1] })
		await new Promise((r) => setTimeout(r, 500))

		const { data: fetched } = await api("POST", "/fetch", {
			ids: [id],
			includeVectors: true,
		})
		const vec = (fetched as { result: Array<{ vector: number[] }> }).result[0].vector
		expect(vec[0]).toBeCloseTo(0, 4)
		expect(vec[2]).toBeCloseTo(1, 4)
	})
})
