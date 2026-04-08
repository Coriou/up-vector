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

	test("update vector is reflected in RediSearch index, not just _vec mirror", async () => {
		// The previous test only verified the base64 _vec mirror round-trips.
		// This one proves the binary `vec` blob (the field RediSearch indexes)
		// is also being updated — without it, KNN queries would still rank by
		// the OLD vector while fetch() returned the new one.
		const ns = "vec-update-indexed"
		await api("POST", `/upsert/${ns}`, [
			{ id: "near-x", vector: [1, 0, 0] },
			{ id: "near-z", vector: [0, 0, 1] },
		])
		await new Promise((r) => setTimeout(r, 500))

		// Move near-x's vector all the way over to z. After update, querying
		// for [0,0,1] should return BOTH ids with score ≈ 1.
		await api("POST", `/update/${ns}`, { id: "near-x", vector: [0, 0, 1] })
		await new Promise((r) => setTimeout(r, 500))

		const { data } = await api("POST", `/query/${ns}`, {
			vector: [0, 0, 1],
			topK: 2,
		})
		const results = (data as { result: Array<{ id: string; score: number }> }).result
		expect(results.length).toBe(2)
		const byId = Object.fromEntries(results.map((r) => [r.id, r.score]))
		expect(byId["near-x"]).toBeCloseTo(1, 2)
		expect(byId["near-z"]).toBeCloseTo(1, 2)

		await api("POST", `/reset/${ns}`)
	})

	test("update vector + PATCH metadata in one request is atomic", async () => {
		// Regression: update.ts used to issue two EVAL calls (one for vector,
		// one for PATCH metadata). A concurrent DELETE between them could
		// silently lose the PATCH while the route still reported updated:1.
		// The fix bundles both into a single Lua script.
		const ns = "atomic-update-patch"
		const id = "combo"
		await api("POST", `/upsert/${ns}`, {
			id,
			vector: [1, 0, 0],
			metadata: { a: 1, b: 2 },
		})

		const { data } = await api("POST", `/update/${ns}`, {
			id,
			vector: [0, 1, 0],
			metadata: { c: 3 },
			metadataUpdateMode: "PATCH",
		})
		expect((data as { result: { updated: number } }).result.updated).toBe(1)

		const { data: fetched } = await api("POST", `/fetch/${ns}`, {
			ids: [id],
			includeMetadata: true,
			includeVectors: true,
		})
		const vec = (
			fetched as {
				result: Array<{ vector: number[]; metadata: Record<string, number> }>
			}
		).result[0]
		// Vector got the new value
		expect(vec.vector[1]).toBeCloseTo(1, 4)
		// PATCH preserved old keys AND added the new one
		expect(vec.metadata).toEqual({ a: 1, b: 2, c: 3 })

		await api("POST", `/reset/${ns}`)
	})

	test("update with no fields returns updated:0 without touching the key", async () => {
		// A request with only the id and no vector / metadata / data should
		// be a no-op — the new atomic path explicitly handles this.
		const id = "no-op-update"
		await api("POST", "/upsert", { id, vector: [1, 0, 0], metadata: { tag: "before" } })
		const { data } = await api("POST", "/update", { id })
		expect((data as { result: { updated: number } }).result.updated).toBe(0)
		const { data: fetched } = await api("POST", "/fetch", {
			ids: [id],
			includeMetadata: true,
		})
		// The original metadata is still there
		expect(
			(fetched as { result: Array<{ metadata: { tag: string } }> }).result[0].metadata.tag,
		).toBe("before")
	})

	test("rejects non-finite numeric ids with 400", async () => {
		// JSON.stringify turns NaN/Infinity into null, but a non-JS client
		// (or a permissive parser) can send `1e1000` which JSON.parse turns
		// into Infinity. The schema should reject these instead of silently
		// coercing to "Infinity"/"NaN" string IDs. We have to send the raw
		// body to bypass JSON.stringify's null-coercion of non-finite numbers.
		const TOKEN = process.env.UPVECTOR_TOKEN ?? "test-token-123"
		const sendRaw = async (raw: string): Promise<number> => {
			const res = await fetch("http://localhost:8080/upsert", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${TOKEN}`,
					"Content-Type": "application/json",
				},
				body: raw,
			})
			return res.status
		}
		expect(await sendRaw('{"id": 1e1000, "vector": [1, 0, 0]}')).toBe(400)
		expect(await sendRaw('{"id": -1e1000, "vector": [1, 0, 0]}')).toBe(400)
	})

	test("rejects empty filter strings on query and delete", async () => {
		// Empty filter strings used to be silently treated as "no filter".
		// They're almost always a client bug (dynamic filter builder produced
		// an empty string), so reject explicitly.
		const { status: queryStatus } = await api("POST", "/query", {
			vector: [1, 0, 0],
			topK: 5,
			filter: "",
		})
		expect(queryStatus).toBe(400)

		const { status: deleteStatus } = await api("POST", "/delete", { filter: "" })
		expect(deleteStatus).toBe(400)
	})
})
