import type { ErrorHandler } from "hono"
import { HTTPException } from "hono/http-exception"
import { ZodError } from "zod"
import { config } from "../config"
import { log } from "../logger"

// Validation error messages from validateNamespace/validateId/filter parser that
// should return 400 (bad input) instead of 500 (server fault).
const VALIDATION_PATTERNS = [
	"must not contain",
	"must not be empty",
	"must not exceed",
	"too long",
	"too deeply nested",
	"Unterminated string",
	"Unexpected character",
	"Unexpected token",
	"Expected value",
	"Expected operator",
	"Expected ",
	"Invalid character",
	"Unclosed array index",
	"Array index too long",
]

function isValidationError(err: Error): boolean {
	return VALIDATION_PATTERNS.some((p) => err.message.includes(p))
}

export const errorHandler: ErrorHandler = (err, c) => {
	if (err instanceof HTTPException) {
		const message = err.message || "Unauthorized"
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

	// Input validation errors (from validateNamespace, validateId, filter parser, …)
	if (err instanceof Error && isValidationError(err)) {
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
