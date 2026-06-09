/**
 * Thrown by validators (keys, filter parser, etc.) when an input is malformed.
 *
 * The global error handler maps these to HTTP 400 instead of 500. Using a
 * dedicated class avoids the previous fragile substring matching of error
 * messages, which could mis-classify unrelated errors (e.g. a Redis "Expected
 * response" error matching the "Expected " pattern) as 400.
 */
export class ValidationError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "ValidationError"
	}
}

/**
 * Thrown when server-side embedding is unavailable or the configured provider
 * fails. The status is intentionally explicit because these errors are neither
 * input schema failures nor generic server bugs.
 */
export class EmbeddingProviderError extends Error {
	readonly status: number

	constructor(message: string, status = 502) {
		super(message)
		this.name = "EmbeddingProviderError"
		this.status = status
	}
}
