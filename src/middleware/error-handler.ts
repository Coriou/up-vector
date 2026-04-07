import type { ErrorHandler } from "hono"
import { HTTPException } from "hono/http-exception"
import { ZodError } from "zod"
import { log } from "../logger"

// Validation error messages that should return 400 instead of 500
const VALIDATION_PATTERNS = ["must not contain", "must not be empty"]

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

	// Input validation errors (from validateNamespace, validateId, etc.)
	if (err instanceof Error && isValidationError(err)) {
		return c.json({ error: err.message, status: 400 }, 400)
	}

	log.error("unhandled error", {
		error: err instanceof Error ? err.message : String(err),
		stack: err instanceof Error ? err.stack : undefined,
	})
	return c.json({ error: "Internal Server Error", status: 500 }, 500)
}
