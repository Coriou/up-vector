import type { MiddlewareHandler } from "hono"
import { log } from "../logger"
import { recordRequest } from "../metrics"

// Extract the base route (first path segment) for metric labeling.
// Falls back to "/unknown" to prevent label cardinality explosion
// and Prometheus format injection from arbitrary paths.
function routeLabel(path: string): string {
	const match = path.match(/^\/([a-z-]+)/)
	return match ? `/${match[1]}` : "/unknown"
}

// X-Request-ID is forwarded from clients when present so distributed traces
// can pin the same id end-to-end. The value lands in our logs and goes back
// out as a response header, so we cap it conservatively and reject anything
// that could either bloat log lines or smuggle control characters / new lines
// into our log output.
const MAX_REQUEST_ID_LENGTH = 128
const REQUEST_ID_CHARSET = /^[A-Za-z0-9_.-]+$/

// Exported for unit testing — fetch() rejects control chars in header values
// before they ever reach this code, so the only way to exercise the regex
// branch is to call the sanitizer directly.
export function sanitizeIncomingRequestId(raw: string | undefined): string | undefined {
	if (!raw) return undefined
	if (raw.length === 0 || raw.length > MAX_REQUEST_ID_LENGTH) return undefined
	if (!REQUEST_ID_CHARSET.test(raw)) return undefined
	return raw
}

export const loggerMiddleware: MiddlewareHandler = async (c, next) => {
	const requestId = sanitizeIncomingRequestId(c.req.header("x-request-id")) ?? crypto.randomUUID()
	c.set("requestId", requestId)
	c.header("X-Request-ID", requestId)

	const start = performance.now()
	await next()
	const duration_ms = Math.round((performance.now() - start) * 100) / 100

	log.info("request", {
		requestId,
		method: c.req.method,
		path: c.req.path,
		status: c.res.status,
		duration_ms,
	})

	recordRequest(c.req.method, c.res.status, duration_ms / 1000, routeLabel(c.req.path))
}
