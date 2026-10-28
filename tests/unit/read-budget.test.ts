import { expect, test } from "bun:test"
import { MAX_PROJECTED_READ_BYTES, reserveReadProjection } from "../../src/read-budget"
import { requestContext } from "../../src/request-context"

const vectors = { includeVectors: true, includeMetadata: false, includeData: false }

test("budget aggregates query batches within one request and resets between requests", () => {
	for (let request = 0; request < 2; request++) {
		requestContext.run({ deadline: Infinity, expired: false }, () => {
			reserveReadProjection(100, vectors)
			expect(() => reserveReadProjection(100, vectors)).toThrow(/Projected read/)
		})
	}
})

test("budget accounts for maximum escaped data and projected metadata", () => {
	expect(() =>
		reserveReadProjection(12, { ...vectors, includeVectors: false, includeData: true }),
	).toThrow(/Projected read/)
	expect(() =>
		reserveReadProjection(1000, { ...vectors, includeVectors: false, includeMetadata: true }),
	).toThrow(/Projected read/)
	expect(() => reserveReadProjection(1000, { ...vectors, includeVectors: false })).not.toThrow()
	expect(MAX_PROJECTED_READ_BYTES).toBe(64 * 1024 * 1024)
})
