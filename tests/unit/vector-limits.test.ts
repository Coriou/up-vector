import { describe, expect, test } from "bun:test"
import { ZodError } from "zod"
import { DenseQuerySchema } from "../../src/routes/query"
import { UpsertBody, VectorSchema } from "../../src/routes/upsert"
import { encodeVectorBase64 } from "../../src/translate/vectors"

const validVector = {
	id: "vec-1",
	vector: [0.1, -0.5, 42.123],
	metadata: { source: "test" },
	data: "hello",
}

describe("vector element validation (Float32 range)", () => {
	test("accepts values within Float32 range", () => {
		expect(VectorSchema.parse(validVector)).toBeDefined()
	})

	test("rejects 1e39 (overflows Float32 to Infinity)", () => {
		// 1e39 passes a plain finite-float64 check but overflows to Infinity in
		// the stored Float32 array, then reads back as JSON null. Must be 400.
		expect(() => VectorSchema.parse({ ...validVector, vector: [1e39] })).toThrow(ZodError)
		try {
			VectorSchema.parse({ ...validVector, vector: [1e39] })
		} catch (err) {
			expect((err as ZodError).issues[0].message).toContain("Float32")
		}
	})

	test("rejects negative overflow", () => {
		expect(() => VectorSchema.parse({ ...validVector, vector: [-1e39] })).toThrow(ZodError)
	})

	test("still rejects NaN and Infinity", () => {
		expect(() => VectorSchema.parse({ ...validVector, vector: [Number.NaN] })).toThrow(ZodError)
		expect(() =>
			VectorSchema.parse({ ...validVector, vector: [Number.POSITIVE_INFINITY] }),
		).toThrow(ZodError)
	})

	test("accepts boundary value 3.4028235e38", () => {
		const parsed = VectorSchema.parse({ ...validVector, vector: [3.4028235e38, -3.4028235e38] })
		// The boundary must survive Float32 encoding without becoming Infinity
		expect(encodeVectorBase64(parsed.vector)).not.toContain("7f8000")
	})

	test("rejects values just past the boundary", () => {
		expect(() => VectorSchema.parse({ ...validVector, vector: [3.5e38] })).toThrow(ZodError)
	})

	test("query vectors enforce the same bound", () => {
		expect(() => DenseQuerySchema.parse({ vector: [1e39] })).toThrow(ZodError)
		expect(DenseQuerySchema.parse({ vector: [-3.4028235e38] })).toBeDefined()
	})
})

describe("upsert field caps", () => {
	test("accepts data at exactly 1_000_000 characters", () => {
		const body = { ...validVector, data: "x".repeat(1_000_000) }
		expect(VectorSchema.parse(body)).toBeDefined()
	})

	test("rejects data over 1_000_000 characters", () => {
		const body = { ...validVector, data: "x".repeat(1_000_001) }
		expect(() => VectorSchema.parse(body)).toThrow(/Data must not exceed 1000000 characters/)
	})

	test("accepts metadata under the byte budget", () => {
		const metadata: Record<string, string> = {}
		for (let i = 0; i < 500; i++) metadata[`key-${i}`] = "y".repeat(200)
		expect(VectorSchema.parse({ ...validVector, metadata })).toBeDefined()
	})

	test("rejects metadata whose JSON serialization exceeds 131072 bytes", () => {
		const metadata: Record<string, string> = {}
		for (let i = 0; i < 1500; i++) metadata[`key-${i}`] = "y".repeat(200)
		expect(JSON.stringify(metadata).length).toBeGreaterThan(131072)
		try {
			VectorSchema.parse({ ...validVector, metadata })
			throw new Error("expected metadata over budget to be rejected")
		} catch (err) {
			expect(err).toBeInstanceOf(ZodError)
			expect((err as ZodError).issues[0].message).toBe(
				"Serialized metadata must not exceed 131072 bytes",
			)
		}
	})

	test("omitted metadata and data remain valid", () => {
		const { id, vector } = validVector
		expect(VectorSchema.parse({ id, vector })).toEqual({ id, vector })
	})
})

describe("UpsertBody", () => {
	test("single-object payloads still parse", () => {
		expect(UpsertBody.parse(validVector)).toBeDefined()
	})

	test("batch payloads still parse", () => {
		expect(UpsertBody.parse([validVector, { id: "vec-2", vector: [1, 2] }])).toHaveLength(2)
	})

	test("batch containing an out-of-range element is rejected", () => {
		expect(() => UpsertBody.parse([validVector, { id: "vec-2", vector: [1e39] }])).toThrow(ZodError)
	})
})
