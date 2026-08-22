import type { MiddlewareHandler } from "hono"
import { config } from "../config"
import { log } from "../logger"

const TIMEOUT_SENTINEL = Symbol("timeout")

export const timeoutMiddleware: MiddlewareHandler = async (c, next) => {
	if (config.requestTimeout === 0) {
		await next()
		return
	}

	let timeoutId: Timer
	const timeoutPromise = new Promise<symbol>((resolve) => {
		timeoutId = setTimeout(() => resolve(TIMEOUT_SENTINEL), config.requestTimeout)
	})

	const work = next()
		.then(() => {
			clearTimeout(timeoutId)
			return undefined
		})
		.catch((err) => {
			clearTimeout(timeoutId)
			throw err
		})

	const result = await Promise.race([work, timeoutPromise])

	if (result === TIMEOUT_SENTINEL) {
		// The race settled on the timeout while `work` was still pending.
		// Observe the loser now — attaching earlier would also catch errors
		// that propagate normally through the race and mislabel every fast
		// handler failure as a "late failure".
		work.catch((err) => {
			log.warn("late failure after request timeout", {
				method: c.req.method,
				path: c.req.path,
				error: err instanceof Error ? err.message : String(err),
			})
		})
		log.warn("request timeout", {
			method: c.req.method,
			path: c.req.path,
			timeout_ms: config.requestTimeout,
		})
		return c.json({ error: "Request Timeout", status: 504 }, 504)
	}
}
