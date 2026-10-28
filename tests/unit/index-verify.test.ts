import { describe, expect, mock, test } from "bun:test"
import { config } from "../../src/config"
import { ValidationError } from "../../src/errors"

type SendFn = (command: string, args: string[]) => Promise<unknown>
let send: SendFn

// createIndexInternal reaches Redis through ../redis's getClient(); stub it so
// the "Index already exists" verification path can be driven deterministically.
mock.module("../../src/redis", () => ({
	getClient: () => ({
		send,
	}),
	// Mirror the real module's remaining exports: Bun 1.4 validates statically
	// bound named exports against whatever this registry hands out, and other
	// suites in the same process bind isRedisHealthy et al.
	initRedis: async () => {},
	isRedisHealthy: async () => true,
	reinitRedis: async () => {},
	closeRedis: async () => {},
}))

// Dynamic import: the module under test must bind the stubbed redis module.
const { ensureIndex, getDetectedDimension, loadDimension } = await import(
	"../../src/translate/index"
)

const resp3Info = (dim: number, metric = "COSINE") => ({
	num_docs: 0,
	attributes: [{ dim, distance_metric: metric }],
})

function existingIndex(info: unknown): void {
	send = async (command) => {
		if (command === "FT.CREATE") throw new Error("Index already exists")
		if (command === "FT.INFO") return info
		throw new Error(`unexpected command ${command}`)
	}
}

describe("existing-index FT.INFO verification", () => {
	test("throws instead of caching when FT.INFO itself fails", async () => {
		send = async (command) => {
			if (command === "FT.CREATE") throw new Error("Index already exists")
			if (command === "FT.INFO") throw new Error("ERR transient proxy failure")
			throw new Error(`unexpected command ${command}`)
		}
		const ns = "verify-ftinfo-failure"
		await expect(ensureIndex(ns, 4)).rejects.toThrow(/could not be verified/)
		expect(getDetectedDimension(ns)).toBeUndefined()
	})

	test("throws instead of caching when FT.INFO yields no readable dimension", async () => {
		existingIndex({ num_docs: 3, attributes: [{ distance_metric: "COSINE" }] })
		const ns = "verify-no-dim"
		await expect(ensureIndex(ns, 4)).rejects.toThrow(/could not be verified/)
		expect(getDetectedDimension(ns)).toBeUndefined()
	})

	test("caches the detected dimension when verification succeeds", async () => {
		existingIndex(resp3Info(7))
		const ns = "verify-success"
		await expect(ensureIndex(ns, 7)).resolves.toBeUndefined()
		expect(getDetectedDimension(ns)).toBe(7)
	})

	test("still raises ValidationError on a real dimension mismatch", async () => {
		existingIndex(resp3Info(8))
		const ns = "verify-mismatch"
		await expect(ensureIndex(ns, 4)).rejects.toThrow(ValidationError)
	})
})

describe("rejected indexes never enter trusted caches", () => {
	test("rechecks an incompatible existing index on every upsert", async () => {
		existingIndex(resp3Info(4, "IP"))
		for (let i = 0; i < 2; i++) {
			await expect(ensureIndex("metric-retry-create", 4)).rejects.toThrow(/metric mismatch/)
			expect(getDetectedDimension("metric-retry-create")).toBeUndefined()
		}
	})
	test("rechecks an incompatible index on every dimension lookup", async () => {
		existingIndex(resp3Info(4, "IP"))
		for (let i = 0; i < 2; i++) {
			await expect(loadDimension("metric-retry-load")).rejects.toThrow(/metric mismatch/)
			expect(getDetectedDimension("metric-retry-load")).toBeUndefined()
		}
	})
})

test("cold dimension lookup accepts Redis metric aliases", async () => {
	const original = config.metric
	try {
		for (const [metric, redisMetric] of [
			["EUCLIDEAN", "L2"],
			["DOT_PRODUCT", "IP"],
		] as const) {
			config.metric = metric
			existingIndex(resp3Info(4, redisMetric))
			await expect(loadDimension(`load-alias-${metric}`)).resolves.toBe(4)
		}
	} finally {
		config.metric = original
	}
})
