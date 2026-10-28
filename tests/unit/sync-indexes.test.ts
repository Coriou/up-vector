import { describe, expect, mock, test } from "bun:test"
import { config } from "../../src/config"

type SendFn = (command: string, args: string[]) => Promise<unknown>
const sendCalls: Array<{ command: string; index: string }> = []
let send: SendFn = async () => null

// syncIndexes reaches Redis through ../redis's getClient(); stub it so the
// startup FT._LIST sweep can be driven deterministically.
mock.module("../../src/redis", () => ({
	getClient: () => ({
		send: (command: string, args: string[]) => {
			sendCalls.push({ command, index: args[0] ?? "" })
			return send(command, args)
		},
		sadd: async () => 1,
	}),
	// Mirror the real module's remaining exports: other suites in the same
	// process statically bind isRedisHealthy et al.
	initRedis: async () => {},
	isRedisHealthy: async () => true,
	reinitRedis: async () => {},
	closeRedis: async () => {},
}))

// Dynamic import (not static): the module under test must bind the redis stub
// mock.module registered above — static hoisting would bind the real module.
const { syncIndexes, getDetectedDimension } = await import("../../src/translate/index")

const resp3Info = (dim: number, metric: string) => ({
	num_docs: 0,
	attributes: [{ dim, distance_metric: metric }],
})

describe("syncIndexes", () => {
	test("ignores foreign FT._LIST indexes instead of aborting startup", async () => {
		// FT._LIST is global to the Redis DB. A foreign app's vector index with a
		// different DISTANCE_METRIC used to be validated like our own and crash
		// startup with a metric-mismatch ValidationError. (deep audit 2026-09-06, F1)
		send = async (command, args) => {
			if (command === "FT._LIST") return ["foreign_index", "idx:app"]
			if (command === "FT.INFO") {
				return args[0] === "foreign_index" ? resp3Info(3, "IP") : resp3Info(8, "COSINE")
			}
			throw new Error(`unexpected command ${command}`)
		}

		await expect(syncIndexes()).resolves.toBeUndefined()

		const infoTargets = sendCalls.filter((c) => c.command === "FT.INFO").map((c) => c.index)
		expect(infoTargets).toEqual(["idx:app"])
	})
})

test("sync does not trust an incompatible dimension", async () => {
	send = async (command) => (command === "FT._LIST" ? ["idx:sync-bad"] : resp3Info(4, "IP"))
	await expect(syncIndexes()).rejects.toThrow(/metric mismatch/)
	expect(getDetectedDimension("sync-bad")).toBeUndefined()
})

test("sync accepts persisted Redis metric aliases", async () => {
	const original = config.metric
	try {
		for (const [metric, redisMetric] of [
			["EUCLIDEAN", "L2"],
			["DOT_PRODUCT", "IP"],
		] as const) {
			config.metric = metric
			send = async (command) =>
				command === "FT._LIST" ? [`idx:alias-${metric}`] : resp3Info(4, redisMetric)
			await expect(syncIndexes()).resolves.toBeUndefined()
		}
	} finally {
		config.metric = original
	}
})
