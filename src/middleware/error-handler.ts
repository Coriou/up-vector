import { STATUS_CODES } from "node:http"
import type { ErrorHandler } from "hono"
import { HTTPException } from "hono/http-exception"
import { ZodError } from "zod"
import { config } from "../config"
import { ValidationError } from "../errors"
import { log } from "../logger"

function statusText(status: number): string {
	return STATUS_CODES[status] ?? "Error"
}

export const errorHandler: ErrorHandler = (err, c) => {
	if (err instanceof HTTPException) {
		// HTTPException can be thrown without a message (e.g. by hono/bearer-auth),
		// in which case `err.message` is empty. Fall back to the canonical HTTP
		// status text so we don't return a misleading "Unauthorized" for a 400.
		const message = err.message || statusText(err.status)
		return c.json({ error: message, status: err.status }, err.status)
	}

	if (err instanceof ZodError) {
		const message = err.issues.map((i) => i.message).join(", ")
		return c.json({ error: message, status: 400 }, 400)
	}

	// Malformed JSON body — return 400, not 500
	if (err instanceof SyntaxError) {
		return c.json({ error: "Invalid JSON body", status: 400 }, 400)
	}

	// Typed validation errors thrown by validators (keys, filter parser, …).
	// Using a class instead of substring matching prevents misclassifying
	// unrelated errors whose message happens to contain a validator phrase.
	if (err instanceof ValidationError) {
		return c.json({ error: err.message, status: 400 }, 400)
	}

	// Stack traces are only logged at debug level — they can leak file paths and
	// internal structure into log aggregators that downstream services consume.
	const includeStack = config.logLevel === "debug"
	log.error("unhandled error", {
		error: err instanceof Error ? err.message : String(err),
		...(includeStack && err instanceof Error ? { stack: err.stack } : {}),
	})
	return c.json({ error: "Internal Server Error", status: 500 }, 500)
}
