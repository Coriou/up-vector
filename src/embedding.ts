import { config } from "./config"
import { EmbeddingProviderError, ValidationError } from "./errors"
import { log } from "./logger"

export type EmbeddingProvider = {
	readonly name: string
	readonly model: string
	embedMany(inputs: string[]): Promise<number[][]>
}

export class DisabledEmbeddingProvider implements EmbeddingProvider {
	readonly name = "disabled"
	readonly model = "disabled"

	async embedMany(): Promise<number[][]> {
		throw new EmbeddingProviderError(
			"Server-side embedding provider is disabled. Set UPVECTOR_EMBEDDING_PROVIDER=openai to enable /upsert-data and /query-data.",
			400,
		)
	}
}

export type FakeEmbeddingProviderOptions = {
	dimension?: number
	model?: string
}

export class FakeEmbeddingProvider implements EmbeddingProvider {
	readonly name = "fake"
	readonly model: string
	private readonly dimension: number

	constructor(options: FakeEmbeddingProviderOptions = {}) {
		this.dimension = options.dimension ?? 8
		if (!Number.isInteger(this.dimension) || this.dimension <= 0) {
			throw new ValidationError("Fake embedding dimension must be a positive integer")
		}
		this.model = options.model ?? "fake-embedding"
	}

	async embedMany(inputs: string[]): Promise<number[][]> {
		return inputs.map((input) => this.embedOne(input))
	}

	private embedOne(input: string): number[] {
		const vector = Array.from({ length: this.dimension }, () => 0)
		const tokens = input.toLowerCase().match(/[a-z0-9]+/g) ?? [input]

		for (const token of tokens) {
			const idx = stableHash(token) % this.dimension
			vector[idx] += 1
		}

		const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
		if (magnitude === 0) {
			vector[stableHash(input) % this.dimension] = 1
			return vector
		}
		return vector.map((value) => value / magnitude)
	}
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type OpenAICompatibleEmbeddingProviderOptions = {
	apiKey: string
	baseUrl?: string
	model?: string
	dimension?: number
	timeoutMs?: number
	retries?: number
	fetchFn?: FetchLike
	retryBaseDelayMs?: number
}

type OpenAIEmbeddingRecord = {
	index?: number
	embedding?: unknown
}

type OpenAIEmbeddingResponse = {
	data?: OpenAIEmbeddingRecord[]
	error?: {
		message?: string
	}
}

/**
 * Provider-side /embeddings requests have per-request budgets (~300k tokens on
 * OpenAI); a locally-valid batch (up to 1000 inputs x up to ~1M chars each)
 * can deterministically exceed them and fail the whole batch with a
 * non-retryable 400. embedMany splits inputs into chunks bounded by both:
 */
export const EMBED_MAX_ITEMS_PER_REQUEST = 256
export const EMBED_MAX_CHARS_PER_REQUEST = 250_000

/**
 * Split inputs into provider-request-sized chunks (greedy: whichever bound —
 * item count or total characters — fills first closes a chunk). A single
 * oversized input still forms its own chunk; the provider enforces per-item
 * limits. Chunk boundaries preserve input order.
 */
export function chunkEmbeddingInputs(inputs: string[]): string[][] {
	const chunks: string[][] = []
	let current: string[] = []
	let currentChars = 0
	for (const input of inputs) {
		if (
			current.length > 0 &&
			(current.length === EMBED_MAX_ITEMS_PER_REQUEST ||
				currentChars + input.length > EMBED_MAX_CHARS_PER_REQUEST)
		) {
			chunks.push(current)
			current = []
			currentChars = 0
		}
		current.push(input)
		currentChars += input.length
	}
	if (current.length > 0) chunks.push(current)
	return chunks
}

/**
 * An in-flight provider request plus its deadline handle. The abort timer
 * stays armed until `settle()` is called after the response BODY is fully
 * consumed — a provider can deliver headers promptly and then stall mid-body,
 * which would otherwise hang forever despite UPVECTOR_EMBEDDING_TIMEOUT_MS.
 */
type RequestDeadline = {
	response: Response
	/** Disarm the deadline (idempotent). Must be called exactly once, after body consumption. */
	settle: () => void
	/** Whether the deadline fired before settle(). */
	timedOut: () => boolean
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
	readonly name = "openai"
	readonly model: string
	private readonly apiKey: string
	private readonly baseUrl: string
	private readonly dimension: number | undefined
	private readonly timeoutMs: number
	private readonly retries: number
	private readonly fetchFn: FetchLike
	private readonly retryBaseDelayMs: number

	constructor(options: OpenAICompatibleEmbeddingProviderOptions) {
		this.apiKey = options.apiKey
		this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "")
		this.model = options.model ?? "text-embedding-3-small"
		this.dimension = options.dimension
		this.timeoutMs = options.timeoutMs ?? 10000
		this.retries = options.retries ?? 2
		this.fetchFn = options.fetchFn ?? fetch
		this.retryBaseDelayMs = options.retryBaseDelayMs ?? 100
	}

	async embedMany(inputs: string[]): Promise<number[][]> {
		if (inputs.length === 0) return []

		const chunks = chunkEmbeddingInputs(inputs)
		// Chunks are embedded sequentially so strict input→embedding order holds;
		// all-or-nothing semantics: any chunk that exhausts its retries fails
		// the entire call.
		const embeddings: number[][] = []
		for (const chunk of chunks) {
			embeddings.push(...(await this.embedChunk(chunk)))
		}
		return embeddings
	}

	private async embedChunk(chunk: string[]): Promise<number[][]> {
		for (let attempt = 0; attempt <= this.retries; attempt++) {
			try {
				const deadline = await this.request(chunk)
				try {
					if (deadline.response.ok) {
						return await this.underDeadline(deadline, () =>
							this.parseResponse(deadline.response, chunk.length),
						)
					}

					if (isRetryableStatus(deadline.response.status) && attempt < this.retries) {
						await sleep(this.retryDelayMs(attempt, deadline.response.headers.get("retry-after")))
						continue
					}

					const message = await this.underDeadline(deadline, () =>
						readProviderError(deadline.response),
					)
					if (message) {
						log.warn("embedding provider error", {
							status: deadline.response.status,
							providerMessage: message,
						})
					}
					throw new EmbeddingProviderError(
						`Embedding provider failed with HTTP ${deadline.response.status}`,
						502,
					)
				} finally {
					deadline.settle()
				}
			} catch (err) {
				if (err instanceof EmbeddingProviderError) {
					if (err.status === 504 && attempt < this.retries) {
						await sleep(this.retryDelayMs(attempt))
						continue
					}
					throw err
				}
				if (attempt < this.retries) {
					await sleep(this.retryDelayMs(attempt))
					continue
				}
				throw new EmbeddingProviderError("Embedding provider request failed", 502)
			}
		}

		throw new EmbeddingProviderError("Embedding provider request failed", 502)
	}

	private async request(inputs: string[]): Promise<RequestDeadline> {
		const body: Record<string, unknown> = {
			model: this.model,
			input: inputs,
		}
		if (this.dimension !== undefined) {
			body.dimensions = this.dimension
		}

		const init = (): RequestInit => ({
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify(body),
		})

		if (this.timeoutMs === 0) {
			// Timeout disabled: no controller, nothing to arm or settle.
			const response = await this.fetchFn(`${this.baseUrl}/embeddings`, init())
			return { response, settle: () => {}, timedOut: () => false }
		}

		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
		try {
			const response = await this.fetchFn(`${this.baseUrl}/embeddings`, {
				...init(),
				signal: controller.signal,
			})
			// Keep the deadline armed across body reads; see RequestDeadline.
			return {
				response,
				settle: () => clearTimeout(timeout),
				timedOut: () => controller.signal.aborted,
			}
		} catch (err) {
			clearTimeout(timeout)
			if (controller.signal.aborted) {
				throw new EmbeddingProviderError("Embedding provider timed out", 504)
			}
			throw err
		}
	}

	/**
	 * Read the response body under the still-armed request deadline. A stalled
	 * body surfaces through the standard timeout error (504), which feeds the
	 * existing retry logic.
	 */
	private async underDeadline<T>(deadline: RequestDeadline, read: () => Promise<T>): Promise<T> {
		try {
			return await read()
		} catch (err) {
			if (deadline.timedOut()) {
				throw new EmbeddingProviderError("Embedding provider timed out", 504)
			}
			throw err
		} finally {
			deadline.settle()
		}
	}

	private headers(): Record<string, string> {
		return {
			Authorization: `Bearer ${this.apiKey}`,
			"Content-Type": "application/json",
		}
	}

	private async parseResponse(response: Response, expectedCount: number): Promise<number[][]> {
		let payload: OpenAIEmbeddingResponse
		try {
			payload = (await response.json()) as OpenAIEmbeddingResponse
		} catch {
			throw new EmbeddingProviderError("Embedding provider returned a non-JSON response", 502)
		}

		if (!Array.isArray(payload.data)) {
			throw new EmbeddingProviderError("Embedding provider returned a malformed response", 502)
		}
		if (payload.data.length !== expectedCount) {
			throw new EmbeddingProviderError(
				`Embedding provider returned ${payload.data.length} embeddings for ${expectedCount} inputs`,
				502,
			)
		}

		const embeddings = payload.data
			.map((record, position) => ({
				index: typeof record.index === "number" ? record.index : position,
				embedding: parseEmbedding(record.embedding),
			}))
			.sort((a, b) => a.index - b.index)
			.map((record) => record.embedding)

		for (const embedding of embeddings) {
			validateConfiguredDimension(embedding, this.dimension)
		}

		return embeddings
	}

	private retryDelayMs(attempt: number, retryAfter?: string | null): number {
		const retryAfterMs = parseRetryAfterMs(retryAfter)
		if (retryAfterMs !== undefined) return retryAfterMs
		return Math.min(this.retryBaseDelayMs * 2 ** attempt, 1000)
	}
}

let embeddingProvider: EmbeddingProvider | undefined

export function getEmbeddingProvider(): EmbeddingProvider {
	if (embeddingProvider) return embeddingProvider

	switch (config.embeddingProvider) {
		case "fake":
			embeddingProvider = new FakeEmbeddingProvider({
				dimension: config.embeddingDimension ?? config.dimension,
				model: config.embeddingModel,
			})
			break
		case "openai":
			embeddingProvider = new OpenAICompatibleEmbeddingProvider({
				apiKey: config.embeddingApiKey ?? "",
				baseUrl: config.embeddingBaseUrl,
				model: config.embeddingModel,
				dimension: config.embeddingDimension,
				timeoutMs: config.embeddingTimeoutMs,
				retries: config.embeddingRetries,
			})
			break
		case "disabled":
			embeddingProvider = new DisabledEmbeddingProvider()
			break
	}

	return embeddingProvider
}

export function validateConfiguredDimension(
	vector: number[],
	expectedDimension: number | undefined,
): void {
	if (expectedDimension !== undefined && vector.length !== expectedDimension) {
		throw new ValidationError(
			`Embedding dimension mismatch: expected ${expectedDimension}, got ${vector.length}`,
		)
	}
}

function parseEmbedding(value: unknown): number[] {
	if (!Array.isArray(value)) {
		throw new EmbeddingProviderError("Embedding provider returned a malformed embedding", 502)
	}
	const vector = value.map((entry) => {
		if (typeof entry !== "number" || !Number.isFinite(entry)) {
			throw new EmbeddingProviderError(
				"Embedding provider returned a non-finite embedding value",
				502,
			)
		}
		return entry
	})
	if (vector.length === 0) {
		throw new EmbeddingProviderError("Embedding provider returned an empty embedding", 502)
	}
	return vector
}

function isRetryableStatus(status: number): boolean {
	return status === 429 || status >= 500
}

async function readProviderError(response: Response): Promise<string> {
	try {
		const payload = (await response.json()) as OpenAIEmbeddingResponse
		return payload.error?.message?.slice(0, 300) ?? ""
	} catch {
		return ""
	}
}

function parseRetryAfterMs(value?: string | null): number | undefined {
	if (!value) return undefined
	const seconds = Number(value)
	if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 5000)
	const date = Date.parse(value)
	if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), 5000)
	return undefined
}

function sleep(ms: number): Promise<void> {
	if (ms <= 0) return Promise.resolve()
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function stableHash(input: string): number {
	let hash = 2166136261
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i)
		hash = Math.imul(hash, 16777619)
	}
	return hash >>> 0
}
