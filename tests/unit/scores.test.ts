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
})
