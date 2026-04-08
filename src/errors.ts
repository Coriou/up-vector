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
