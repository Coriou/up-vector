import { describe, expect, test } from "bun:test"
import {
	chunkEmbeddingInputs,
	EMBED_MAX_CHARS_PER_REQUEST,
	EMBED_MAX_ITEMS_PER_REQUEST,
	OpenAICompatibleEmbeddingProvider,
} from "../../src/embedding"
import { EmbeddingProviderError } from "../../src/errors"

/**
 * A 200 response whose headers resolve immediately but whose body never
 * produces bytes on its own. The body only errors when the request deadline
 * aborts, mimicking an upstream that hangs between headers and body — the
 * provider-side behavior the armed-through-consumption deadline guards against.
 */
function stalledBodyResponse(signal: AbortSignal | null | undefined): Response {
	let streamController!: ReadableStreamDefaultController
	const body = new ReadableStream({
		start(controller) {
			streamController = controller
			signal?.addEventListener("abort", () => {
				streamController.error(new DOMException("aborted", "AbortError"))
			})
		},
	})
	return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } })
}

describe("chunkEmbeddingInputs", () => {
	test("returns no chunks for empty input lists", () => {
		expect(chunkEmbeddingInputs([])).toEqual([])
	})

	test("keeps a small batch under both bounds in a single chunk", () => {
		const inputs = ["first", "second", "third"]
		expect(chunkEmbeddingInputs(inputs)).toEqual([inputs])
	})

	test("splits at the item-count bound", () => {
		const inputs = Array.from({ length: EMBED_MAX_ITEMS_PER_REQUEST + 4 }, (_, i) => `i${i}`)
		expect(chunkEmbeddingInputs(inputs)).toEqual([
			inputs.slice(0, EMBED_MAX_ITEMS_PER_REQUEST),
			inputs.slice(EMBED_MAX_ITEMS_PER_REQUEST),
		])
	})

	test("splits at the character budget bound and fills chunks greedily", () => {
		// Each slice fits three of these under the budget, but a fourth overflows.
		const wide = "w".repeat(Math.floor(EMBED_MAX_CHARS_PER_REQUEST / 3))
		const inputs = Array.from({ length: 6 }, () => wide)

		const chunks = chunkEmbeddingInputs(inputs)

		expect(chunks.map((chunk) => chunk.length)).toEqual([3, 3])
		for (const chunk of chunks) {
			const chars = chunk.reduce((sum, item) => sum + item.length, 0)
			expect(chars).toBeLessThanOrEqual(EMBED_MAX_CHARS_PER_REQUEST)
		}
		expect(chunks.flat()).toEqual(inputs)
	})

	test("keeps an exact character-budget fit in one chunk", () => {
		const head = "a".repeat(EMBED_MAX_CHARS_PER_REQUEST - 1)
		const tail = "t"

		expect(chunkEmbeddingInputs([head, tail])).toEqual([[head, tail]])
	})

	test("gives an oversized single input its own chunk", () => {
		const oversized = "z".repeat(EMBED_MAX_CHARS_PER_REQUEST + 1)

		expect(chunkEmbeddingInputs(["head", oversized, "tail"])).toEqual([
			["head"],
			[oversized],
			["tail"],
		])
	})
})

describe("OpenAICompatibleEmbeddingProvider batching", () => {
	test("skips provider calls entirely for empty inputs", async () => {
		let calls = 0
		const provider = new OpenAICompatibleEmbeddingProvider({
			apiKey: "test-key",
			retries: 0,
			fetchFn: async () => {
				calls++
				throw new Error("provider must not be called")
			},
		})

		await expect(provider.embedMany([])).resolves.toEqual([])
		expect(calls).toBe(0)
	})

	test("sends a small batch as one request and restores response order", async () => {
		const requests: RequestInit[] = []
		const provider = new OpenAICompatibleEmbeddingProvider({
			apiKey: "test-key",
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
		expect(JSON.parse(requests[0].body as string)).toMatchObject({
			input: ["first", "second"],
		})
	})

	test("preserves strict input-to-embedding order across chunked batches", async () => {
		// Two of these fit under the char budget, so six inputs become three
		// sequential chunks with their own request boundaries.
		const inputs = Array.from({ length: 6 }, (_, i) => `${i}:${"x".repeat(100_000)}`)
		const indexByItem = new Map(inputs.map((value, i) => [value, i] as const))
		const index = (item: string) => indexByItem.get(item) ?? -1

		const seenChunks: number[][] = []
		const provider = new OpenAICompatibleEmbeddingProvider({
			apiKey: "test-key",
			dimension: 2,
			retries: 0,
			fetchFn: async (_url, init) => {
				const items = (JSON.parse(init?.body as string) as { input: string[] }).input
				seenChunks.push(items.map(index))
				// Shuffle to exercise the index-based order restoration per chunk.
				const data = items
					.map((item) => ({ index: index(item), embedding: [index(item), 0] }))
					.reverse()
				return Response.json({ data })
			},
		})

		const embeddings = await provider.embedMany(inputs)

		expect(seenChunks).toEqual([
			[0, 1],
			[2, 3],
			[4, 5],
		])
		// output[i] corresponds to input[i], never to a chunk-local position.
		expect(embeddings.map((vector) => vector[0])).toEqual([0, 1, 2, 3, 4, 5])
		expect(embeddings.map((vector) => vector[1])).toEqual([0, 0, 0, 0, 0, 0])
	})

	test("fails the whole call when one chunk exhausts its retries", async () => {
		// Two items per chunk under the char budget → three chunks in sequence.
		const inputs = Array.from({ length: 6 }, (_, i) => `${i}:${"x".repeat(100_000)}`)
		const indexByItem = new Map(inputs.map((value, i) => [value, i] as const))

		const seenChunks: number[][] = []
		let calls = 0
		const provider = new OpenAICompatibleEmbeddingProvider({
			apiKey: "test-key",
			dimension: 2,
			retries: 1,
			retryBaseDelayMs: 0,
			fetchFn: async (_url, init) => {
				calls++
				const items = (JSON.parse(init?.body as string) as { input: string[] }).input
				const indices = items.map((item) => indexByItem.get(item) ?? -1)
				if (indices[0] !== 2) {
					// First chunk succeeds; any later chunk stays unreachable here.
					seenChunks.push(indices)
					return Response.json({
						data: indices.map((index) => ({ index, embedding: [index, 0] })),
					})
				}
				return Response.json({ error: { message: "overloaded" } }, { status: 500 })
			},
		})

		try {
			await provider.embedMany(inputs)
			throw new Error("expected provider to fail")
		} catch (err) {
			expect(err).toBeInstanceOf(EmbeddingProviderError)
			expect((err as EmbeddingProviderError).status).toBe(502)
			expect((err as Error).message).toContain("HTTP 500")
		}
		expect(seenChunks).toEqual([[0, 1]])
		// One success + one retry burn for the failing chunk; nothing further.
		expect(calls).toBe(3)
	})
})

// Deliberate platform-clock use below: the subject arms its own real
// setTimeout deadlines inside the module under test, which is precisely the
// behavior being verified; fake timers cannot reach that internal timer.

describe("OpenAICompatibleEmbeddingProvider deadlines", () => {
	test("keeps the deadline armed across body consumption", async () => {
		let calls = 0
		const provider = new OpenAICompatibleEmbeddingProvider({
			apiKey: "test-key",
			timeoutMs: 20,
			retries: 0,
			fetchFn: async (_url, init) => {
				calls++
				return stalledBodyResponse(init?.signal)
			},
		})

		// Same timeout error shape as a request-phase timeout (see the hung
		// request test above): a prompt-header stall still lands on the 504 path.
		await expect(provider.embedMany(["hello"])).rejects.toMatchObject({
			name: "EmbeddingProviderError",
			status: 504,
		})
		expect(calls).toBe(1)
	})

	test("routes stalled-body timeouts through the standard timeout retry path", async () => {
		let calls = 0
		const provider = new OpenAICompatibleEmbeddingProvider({
			apiKey: "test-key",
			timeoutMs: 15,
			retries: 1,
			retryBaseDelayMs: 0,
			fetchFn: async (_url, init) => {
				calls++
				return stalledBodyResponse(init?.signal)
			},
		})

		await expect(provider.embedMany(["hello"])).rejects.toMatchObject({
			name: "EmbeddingProviderError",
			status: 504,
		})
		// The 504 consumed the configured retry before surfacing.
		expect(calls).toBe(2)
	})

	test("does not arm a timeout when timeoutMs is 0", async () => {
		let deliverBody: ((payload: string) => void) | undefined
		const provider = new OpenAICompatibleEmbeddingProvider({
			apiKey: "test-key",
			dimension: 2,
			timeoutMs: 0,
			retries: 0,
			fetchFn: async () => {
				const encoder = new TextEncoder()
				// Headers and metadata arrive now; only delivering the payload body
				// lets json() settle.
				const body = new ReadableStream({
					start(controller) {
						deliverBody = (payload) => {
							controller.enqueue(encoder.encode(payload))
							controller.close()
						}
					},
				})
				return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } })
			},
		})

		const pending = provider.embedMany(["hello"])

		// While the body stalls, the call stays pending — no deadline rejects it.
		// The probe window is safe only because timeoutMs === 0 arms nothing;
		// no internal timer exists that this wait could race against.
		const { promise: probeFired, resolve: markPending } = Promise.withResolvers<"probe">()
		setTimeout(markPending, 10)
		const state = await Promise.race([
			pending.then(
				() => "settled" as const,
				() => "settled" as const,
			),
			probeFired.then(() => "pending" as const),
		])
		expect(state).toBe("pending")

		if (!deliverBody) throw new Error("expected fetch to have been called")
		deliverBody(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }))
		await expect(pending).resolves.toEqual([[1, 0]])
	})
})
