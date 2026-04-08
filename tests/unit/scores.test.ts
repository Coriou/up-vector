import { describe, expect, test } from "bun:test"
import { normalizeScore } from "../../src/translate/scores"

describe("normalizeScore", () => {
	describe("COSINE", () => {
		test("identical vectors (distance=0) -> score=1", () => {
			expect(normalizeScore(0, "COSINE")).toBe(1)
		})

		test("opposite vectors (distance=2) -> score=0", () => {
			expect(normalizeScore(2, "COSINE")).toBe(0)
		})

		test("orthogonal (distance=1) -> score=0.5", () => {
			expect(normalizeScore(1, "COSINE")).toBe(0.5)
		})

		test("intermediate distance", () => {
			expect(normalizeScore(0.5, "COSINE")).toBe(0.75)
		})
	})

	describe("EUCLIDEAN", () => {
		test("identical (distance=0) -> score=1", () => {
			expect(normalizeScore(0, "EUCLIDEAN")).toBe(1)
		})

		test("distance=1 -> score=0.5", () => {
			expect(normalizeScore(1, "EUCLIDEAN")).toBe(0.5)
		})

		test("large distance -> score near 0", () => {
			expect(normalizeScore(999, "EUCLIDEAN")).toBeCloseTo(0.001, 3)
		})
	})

	describe("DOT_PRODUCT", () => {
		test("negative distance (high similarity) -> high score", () => {
			expect(normalizeScore(-1, "DOT_PRODUCT")).toBe(1)
		})

		test("zero distance -> score=0.5", () => {
			expect(normalizeScore(0, "DOT_PRODUCT")).toBe(0.5)
		})

		test("positive distance (low similarity) -> low score", () => {
			expect(normalizeScore(1, "DOT_PRODUCT")).toBe(0)
		})
	})

	describe("edge cases", () => {
		test("NaN distance returns NaN", () => {
			expect(normalizeScore(Number.NaN, "COSINE")).toBeNaN()
		})

		test("Infinity distance EUCLIDEAN -> 0", () => {
			expect(normalizeScore(Number.POSITIVE_INFINITY, "EUCLIDEAN")).toBe(0)
		})

		test("negative distance EUCLIDEAN", () => {
			// Shouldn't happen in practice, but should not crash
			const score = normalizeScore(-1, "EUCLIDEAN")
			expect(typeof score).toBe("number")
		})
	})

	describe("clamping (non-unit vectors)", () => {
		// For non-normalized vectors, dot product is unbounded, so the
		// raw "1 - dist/2" formula can drift outside [0, 1]. The normalizer
		// must clamp so API consumers never see scores like 1.5 or -0.3.
		test("DOT_PRODUCT score clamps to 1 when raw distance very negative", () => {
			expect(normalizeScore(-3, "DOT_PRODUCT")).toBe(1)
		})

		test("DOT_PRODUCT score clamps to 0 when raw distance very positive", () => {
			expect(normalizeScore(5, "DOT_PRODUCT")).toBe(0)
		})

		test("COSINE score clamps to 0 if Redis returns dist > 2", () => {
			// Float drift can push cosine distance just past 2; clamp instead of
			// returning a tiny negative.
			expect(normalizeScore(2.0001, "COSINE")).toBe(0)
		})

		test("COSINE score clamps to 1 if Redis returns dist < 0", () => {
			expect(normalizeScore(-0.0001, "COSINE")).toBe(1)
		})

		test("EUCLIDEAN score clamps to 1 for negative distance", () => {
			expect(normalizeScore(-1, "EUCLIDEAN")).toBe(1)
		})
	})
})
