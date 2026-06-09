import { config } from "./config"
import { EmbeddingProviderError, ValidationError } from "./errors"

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

		for (let attempt = 0; attempt <= this.retries; attempt++) {
			try {
				const response = await this.request(inputs)
				if (response.ok) {
					return await this.parseResponse(response, inputs.length)
				}

				if (isRetryableStatus(response.status) && attempt < this.retries) {
					await sleep(this.retryDelayMs(attempt, response.headers.get("retry-after")))
					continue
				}

				const message = await readProviderError(response)
				throw new EmbeddingProviderError(
					`Embedding provider failed with HTTP ${response.status}${message ? `: ${message}` : ""}`,
					502,
				)
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

	private async request(inputs: string[]): Promise<Response> {
		const body: Record<string, unknown> = {
			model: this.model,
			input: inputs,
		}
		if (this.dimension !== undefined) {
			body.dimensions = this.dimension
		}

		if (this.timeoutMs === 0) {
			return this.fetchFn(`${this.baseUrl}/embeddings`, {
				method: "POST",
				headers: this.headers(),
				body: JSON.stringify(body),
			})
		}

		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
		try {
			return await this.fetchFn(`${this.baseUrl}/embeddings`, {
				method: "POST",
				headers: this.headers(),
				body: JSON.stringify(body),
				signal: controller.signal,
			})
		} catch (err) {
			if (controller.signal.aborted) {
				throw new EmbeddingProviderError("Embedding provider timed out", 504)
			}
			throw err
		} finally {
			clearTimeout(timeout)
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
