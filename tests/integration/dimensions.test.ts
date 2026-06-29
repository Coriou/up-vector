import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { api } from "./setup"

// Dimension validation (src/routes/upsert.ts) was previously only exercised
// through the embedding/data path; these cover the explicit-vector path.
describe("dimension validation", () => {
	const ns = "dim-mismatch-ns"
	const batchNs = "dim-batch-ns"

	beforeAll(async () => {
		await api("POST", `/reset/${ns}`)
		await api("POST", `/reset/${batchNs}`)
	})
	afterAll(async () => {
		await api("POST", `/reset/${ns}`)
		await api("POST", `/reset/${batchNs}`)
	})

	test("a vector whose dimension differs from the namespace → 400", async () => {
		const first = await api("POST", `/upsert/${ns}`, { id: "a", vector: [1, 0, 0] })
		expect(first.status).toBe(200)

		const mismatched = await api("POST", `/upsert/${ns}`, { id: "b", vector: [1, 0] })
		expect(mismatched.status).toBe(400)
		expect((mismatched.data as { error: string }).error).toContain("Dimension mismatch")
	})

	test("mixed dimensions within a single batch → 400", async () => {
		const res = await api("POST", `/upsert/${batchNs}`, [
			{ id: "a", vector: [1, 0, 0] },
			{ id: "b", vector: [1, 0] },
		])
		expect(res.status).toBe(400)
		expect((res.data as { error: string }).error).toContain("Dimension mismatch")
	})
})
