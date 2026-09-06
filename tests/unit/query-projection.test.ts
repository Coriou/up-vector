import { describe, expect, mock, test } from "bun:test"

type SendFn = (command: string, args: string[]) => Promise<unknown>
const searchArgs: string[][] = []
let send: SendFn = async () => ({ results: [] })

// executeQuery reaches Redis through ../redis's getClient(); stub it so the
// FT.SEARCH argument construction can be inspected. (deep audit 2026-09-06, F6)
mock.module("../../src/redis", () => ({
	getClient: () => ({
		send: (command: string, args: string[]) => {
			if (command === "FT.SEARCH") searchArgs.push(args)
			return send(command, args)
		},
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
const { executeQuery } = await import("../../src/routes/query")

const resp3Search = {
	total_results: 1,
	results: [
		{
			id: "v:proj-test:vec-1",
			extra_attributes: { _score: "0.5" },
		},
	],
}

function ftInfo(): unknown {
	return { num_docs: 0, attributes: [{ dim: 3, distance_metric: "COSINE" }] }
}

function returnBlock(args: string[]): string[] {
	const idx = args.indexOf("RETURN")
	if (idx === -1) return []
	const count = Number(args[idx + 1])
	return args.slice(idx + 2, idx + 2 + count)
}

describe("FT.SEARCH field projection", () => {
	test("projects only _score when no fields are requested", async () => {
		send = async (command) => {
			if (command === "FT.INFO") return ftInfo()
			if (command === "FT.SEARCH") return resp3Search
			throw new Error(`unexpected command ${command}`)
		}

		await executeQuery("proj-test", {
			vector: [1, 2, 3],
			topK: 5,
			includeMetadata: false,
			includeVectors: false,
			includeData: false,
		})

		const args = searchArgs.at(-1)
		expect(args).toBeDefined()
		// NOCONTENT alone would drop the _score attribute the parser reads.
		expect(args?.includes("NOCONTENT")).toBe(false)
		expect(returnBlock(args ?? [])).toEqual(["_score"])
	})

	test("projects metadata for filtered queries without transferring vectors", async () => {
		send = async (command) => {
			if (command === "FT.INFO") return ftInfo()
			if (command === "FT.SEARCH") return resp3Search
			throw new Error(`unexpected command ${command}`)
		}

		await executeQuery("proj-test", {
			vector: [1, 2, 3],
			topK: 5,
			filter: "genre = 'drama'",
			includeMetadata: false,
			includeVectors: false,
			includeData: false,
		})

		const fields = returnBlock(searchArgs.at(-1) ?? [])
		expect(fields).toContain("_score")
		expect(fields).toContain("metadata")
		expect(fields).not.toContain("_vec")
		expect(fields).not.toContain("data")
	})

	test("projects every requested include* field", async () => {
		send = async (command) => {
			if (command === "FT.INFO") return ftInfo()
			if (command === "FT.SEARCH") return resp3Search
			throw new Error(`unexpected command ${command}`)
		}

		await executeQuery("proj-test", {
			vector: [1, 2, 3],
			topK: 5,
			includeMetadata: true,
			includeVectors: true,
			includeData: true,
		})

		const fields = returnBlock(searchArgs.at(-1) ?? [])
		expect(fields).toEqual(["_score", "metadata", "_vec", "data"])
	})
})
