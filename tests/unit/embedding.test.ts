import { describe, expect, test } from "bun:test"
import {
	DisabledEmbeddingProvider,
	FakeEmbeddingProvider,
	OpenAICompatibleEmbeddingProvider,
	validateConfiguredDimension,
} from "../../src/embedding"
import { EmbeddingProviderError, ValidationError } from "../../src/errors"

describe("FakeEmbeddingProvider", () => {
	test("returns deterministic vectors with the configured dimension", async () => {
		const provider = new FakeEmbeddingProvider({ dimension: 6 })
		const [a, b] = await provider.embedMany(["alpha beta", "alpha beta"])

		expect(a).toEqual(b)
		expect(a.length).toBe(6)
		expect(Math.sqrt(a.reduce((sum, value) => sum + value * value, 0))).toBeCloseTo(1, 6)
	})

	test("rejects invalid fake dimensions", () => {
		expect(() => new FakeEmbeddingProvider({ dimension: 0 })).toThrow(ValidationError)
	})
})

describe("DisabledEmbeddingProvider", () => {
	test("fails with an explicit 400", async () => {
		const provider = new DisabledEmbeddingProvider()

		try {
			await provider.embedMany()
			throw new Error("expected provider to fail")
		} catch (err) {
			expect(err).toBeInstanceOf(EmbeddingProviderError)
			expect((err as EmbeddingProviderError).status).toBe(400)
			expect((err as Error).message).toContain("disabled")
		}
	})
})

describe("OpenAICompatibleEmbeddingProvider", () => {
	test("sends OpenAI-compatible embedding requests and restores response order", async () => {
		const requests: RequestInit[] = []
		const provider = new OpenAICompatibleEmbeddingProvider({
			apiKey: "test-key",
			baseUrl: "https://example.test/v1/",
			model: "test-model",
			dimension: 3,
			retries: 0,
			fetchFn: async (_url, init) => {
				requests.push(init ?? {})
				return Response.json({
					data: [
						{ index: 1, embedding: [0, 1, 0] },
						{ index: 0, embedding: [1, 0, 0] },
					],
				})
			},
		})

		const embeddings = await provider.embedMany(["first", "second"])

		expect(embeddings).toEqual([
			[1, 0, 0],
			[0, 1, 0],
		])
		expect(requests.length).toBe(1)
		expect((requests[0].headers as Record<string, string>).Authorization).toBe("Bearer test-key")
		expect(JSON.parse(requests[0].body as string)).toEqual({
			model: "test-model",
			input: ["first", "second"],
			dimensions: 3,
		})
	})

	test("retries transient provider failures", async () => {
		let calls = 0
		const provider = new OpenAICompatibleEmbeddingProvider({
			apiKey: "test-key",
			dimension: 2,
			retries: 1,
			retryBaseDelayMs: 0,
			fetchFn: async () => {
				calls++
				if (calls === 1) {
					return Response.json({ error: { message: "try later" } }, { status: 500 })
				}
				return Response.json({ data: [{ index: 0, embedding: [1, 0] }] })
			},
		})

		await expect(provider.embedMany(["hello"])).resolves.toEqual([[1, 0]])
		expect(calls).toBe(2)
	})

	test("maps provider HTTP errors to EmbeddingProviderError", async () => {
		const provider = new OpenAICompatibleEmbeddingProvider({
			apiKey: "test-key",
			retries: 0,
			fetchFn: async () => Response.json({ error: { message: "bad key" } }, { status: 401 }),
		})

		try {
			await provider.embedMany(["hello"])
			throw new Error("expected provider to fail")
		} catch (err) {
			expect(err).toBeInstanceOf(EmbeddingProviderError)
			expect((err as EmbeddingProviderError).status).toBe(502)
			expect((err as Error).message).toContain("HTTP 401")
		}
	})

	test("times out hung provider requests", async () => {
		const provider = new OpenAICompatibleEmbeddingProvider({
			apiKey: "test-key",
			timeoutMs: 1,
			retries: 0,
			fetchFn: (_url, init) => {
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						reject(new DOMException("aborted", "AbortError"))
					})
				})
			},
		})

		await expect(provider.embedMany(["hello"])).rejects.toMatchObject({
			name: "EmbeddingProviderError",
			status: 504,
		})
	})

	test("validates configured embedding dimension", () => {
		expect(() => validateConfiguredDimension([1, 2, 3], 2)).toThrow(ValidationError)
		expect(() => validateConfiguredDimension([1, 2, 3], 3)).not.toThrow()
	})

	test("rejects malformed provider embeddings", async () => {
		const provider = new OpenAICompatibleEmbeddingProvider({
			apiKey: "test-key",
			retries: 0,
			fetchFn: async () => Response.json({ data: [{ index: 0, embedding: [Number.NaN] }] }),
		})

		await expect(provider.embedMany(["hello"])).rejects.toBeInstanceOf(EmbeddingProviderError)
	})
})
