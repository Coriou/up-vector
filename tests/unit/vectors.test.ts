import { describe, expect, test } from "bun:test"
import { decodeVectorBase64, encodeVector, encodeVectorBase64 } from "../../src/translate/vectors"

describe("encodeVector", () => {
	test("produces correct Float32 buffer", () => {
		const encoded = encodeVector([1.0, 2.0, 3.0, 4.0])
		expect(encoded).toBeInstanceOf(Buffer)
		expect(encoded.byteLength).toBe(16) // 4 floats * 4 bytes
	})

	test("handles empty vector", () => {
		expect(encodeVector([]).byteLength).toBe(0)
	})
})

describe("encodeVectorBase64 / decodeVectorBase64", () => {
	test("round-trips a simple vector", () => {
		const input = [1.0, 2.0, 3.0, 4.0]
		const b64 = encodeVectorBase64(input)
		expect(typeof b64).toBe("string")
		expect(decodeVectorBase64(b64)).toEqual(input)
	})

	test("round-trips values with high bytes (the UTF-8 corruption case)", () => {
		// These values produce bytes >= 0x80 in Float32 representation
		const input = [0.1, -0.5, 42.123, 0.0]
		const b64 = encodeVectorBase64(input)
		const decoded = decodeVectorBase64(b64)
		for (let i = 0; i < input.length; i++) {
			expect(decoded[i]).toBeCloseTo(input[i], 5)
		}
	})

	test("handles empty vector", () => {
		expect(decodeVectorBase64(encodeVectorBase64([]))).toEqual([])
	})

	test("handles negative zero", () => {
		const decoded = decodeVectorBase64(encodeVectorBase64([-0.0]))
		expect(Object.is(decoded[0], -0)).toBe(true)
	})

	test("handles large vectors (1536 dims)", () => {
		const input = Array.from({ length: 1536 }, (_, i) => i * 0.001 - 0.768)
		const decoded = decodeVectorBase64(encodeVectorBase64(input))
		expect(decoded.length).toBe(1536)
		for (let i = 0; i < input.length; i++) {
			expect(decoded[i]).toBeCloseTo(input[i], 4)
		}
	})

	test("handles special float values", () => {
		const input = [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -0]
		const decoded = decodeVectorBase64(encodeVectorBase64(input))
		expect(decoded[0]).toBe(Number.POSITIVE_INFINITY)
		expect(decoded[1]).toBe(Number.NEGATIVE_INFINITY)
		expect(decoded[2]).toBe(0)
		expect(Object.is(decoded[3], -0)).toBe(true)
	})

	test("NaN round-trips", () => {
		const decoded = decodeVectorBase64(encodeVectorBase64([Number.NaN]))
		expect(decoded[0]).toBeNaN()
	})

	test("very small and very large numbers", () => {
		const input = [1e-38, 1e38, -1e-38, -1e38]
		const decoded = decodeVectorBase64(encodeVectorBase64(input))
		// Float32 has ~7 significant digits of precision
		for (let i = 0; i < input.length; i++) {
			const rel = Math.abs((decoded[i] - input[i]) / input[i])
			expect(rel).toBeLessThan(1e-6)
		}
	})

	test("rejects buffer length not a multiple of 4", () => {
		// 6 bytes is not a multiple of 4 — must throw, not silently truncate
		const corrupt = Buffer.from([0x00, 0x00, 0x80, 0x3f, 0x00, 0x00]).toString("base64")
		expect(() => decodeVectorBase64(corrupt)).toThrow("multiple of 4 bytes")
	})

	test("works regardless of buffer pool offset", () => {
		// Buffer.from() returns views into Bun's pool with arbitrary byteOffset.
		// Float32Array requires byteOffset % 4 === 0, so the decoder copies into
		// a fresh aligned buffer. Without this, decoding would throw on some inputs.
		for (let trial = 0; trial < 100; trial++) {
			const input = Array.from({ length: 4 }, () => Math.random())
			const b64 = encodeVectorBase64(input)
			const decoded = decodeVectorBase64(b64)
			for (let i = 0; i < input.length; i++) {
				expect(decoded[i]).toBeCloseTo(input[i], 5)
			}
		}
	})
})
