import { describe, expect, test } from "bun:test"
import { ValidationError } from "../../src/errors"
import { parseMetricFromInfo, validateIndexCompatibility } from "../../src/translate/index"

describe("parseMetricFromInfo", () => {
	test("reads distance_metric from RESP3 object shape", () => {
		const info = {
			num_docs: 3,
			attributes: [{ identifier: "vec", type: "VECTOR", dim: "8", distance_metric: "COSINE" }],
		}
		expect(parseMetricFromInfo(info)).toBe("COSINE")
	})

	test("reads DISTANCE_METRIC from RESP2 flat array shape", () => {
		const info = [
			"num_docs",
			"3",
			"attributes",
			[["identifier", "vec", "TYPE", "FLOAT32", "DIM", "8", "DISTANCE_METRIC", "EUCLIDEAN"]],
		]
		expect(parseMetricFromInfo(info)).toBe("EUCLIDEAN")
	})

	test("returns undefined when no attribute carries a metric", () => {
		expect(parseMetricFromInfo({ attributes: [{ dim: "8" }] })).toBeUndefined()
		expect(parseMetricFromInfo(undefined)).toBeUndefined()
		expect(parseMetricFromInfo("garbage")).toBeUndefined()
	})
})

describe("validateIndexCompatibility", () => {
	test("accepts a matching index", () => {
		expect(() => validateIndexCompatibility("ns", 8, "COSINE", 8, "COSINE")).not.toThrow()
	})

	test("comparison is case-insensitive on metric", () => {
		expect(() => validateIndexCompatibility("ns", 8, "cosine", 8, "COSINE")).not.toThrow()
	})

	test("rejects a metric mismatch loudly", () => {
		expect(() => validateIndexCompatibility("movies", 8, "EUCLIDEAN", 8, "COSINE")).toThrow(
			ValidationError,
		)
		try {
			validateIndexCompatibility("movies", 8, "EUCLIDEAN", 8, "COSINE")
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err)
			expect(msg).toContain("Distance metric mismatch")
			expect(msg).toContain("movies")
			expect(msg).toContain("EUCLIDEAN")
			expect(msg).toContain("COSINE")
		}
	})

	test("keeps rejecting a dimension mismatch with the established message", () => {
		expect(() => validateIndexCompatibility("ns", 16, "COSINE", 8, "COSINE")).toThrow(
			/Dimension mismatch: namespace expects 16, got 8/,
		)
	})

	test("skips checks for attributes the index info did not expose", () => {
		expect(() => validateIndexCompatibility("ns", undefined, undefined, 8, "COSINE")).not.toThrow()
	})
})
