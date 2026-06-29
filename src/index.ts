import { config } from "./config"
import { log } from "./logger"
import { closeRedis, initRedis, isRedisHealthy, reinitRedis } from "./redis"
import { app } from "./server"
import { setShuttingDown } from "./shutdown"
import { syncIndexes } from "./translate/index"

/** Redact credentials from a Redis URL for safe logging */
function redactUrl(url: string): string {
	try {
		const u = new URL(url)
		if (u.password) u.password = "***"
		if (u.username && u.username !== "default") u.username = "***"
		return u.toString()
	} catch {
		return "***"
	}
}

async function main(): Promise<void> {
	await initRedis()
	log.info("connected to redis", { url: redactUrl(config.redisUrl) })

	await syncIndexes()
	log.info("index sync complete")

	const server = Bun.serve({
		fetch: app.fetch,
		port: config.port,
		hostname: config.host,
	})

	log.info("server started", {
		host: server.hostname,
		port: server.port,
		metric: config.metric,
		metricsEnabled: config.metricsEnabled,
	})

	let shuttingDownInProgress = false

	const shutdown = async (signal: string) => {
		if (shuttingDownInProgress) {
			log.warn("forced exit on second signal", { signal })
			process.exit(1)
		}
		shuttingDownInProgress = true
		setShuttingDown()
		log.info("shutdown signal received", { signal })

		// Force exit if drain takes too long
		const forceTimer = setTimeout(() => {
			log.warn("shutdown timeout exceeded, forcing exit", {
				timeout_ms: config.shutdownTimeout,
			})
			process.exit(1)
		}, config.shutdownTimeout)

		try {
			// Wait for in-flight requests to complete
			await server.stop()
			log.info("requests drained")

			await closeRedis()
			log.info("shutdown complete")

			clearTimeout(forceTimer)
			process.exit(0)
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err)
			log.error("shutdown error, forcing exit", { error: msg })
			process.exit(1)
		}
	}

	process.on("SIGTERM", () => shutdown("SIGTERM"))
	process.on("SIGINT", () => shutdown("SIGINT"))

	// A stray rejection elsewhere must not vanish silently. Log loudly but stay
	// up — a single bad request shouldn't take down the service. (The timeout
	// path's late rejection is already absorbed by Promise.race.)
	process.on("unhandledRejection", (reason) => {
		const msg = reason instanceof Error ? reason.message : String(reason)
		const stack = reason instanceof Error ? reason.stack : undefined
		log.error("unhandled promise rejection", { error: msg, stack })
	})

	// After an uncaught exception the process is in an undefined state; log and
	// exit rather than resume. A supervisor (restart: unless-stopped) brings up a
	// clean instance.
	process.on("uncaughtException", (err) => {
		log.error("uncaught exception, exiting", { error: err.message, stack: err.stack })
		setShuttingDown()
		process.exit(1)
	})

	// Redis self-heal watchdog: Bun's client never recovers once its reconnect
	// attempts are exhausted, leaving the proxy serving 5xx forever even after
	// Redis returns. Recreate the client once Redis has been continuously
	// unhealthy past the configured threshold.
	if (config.redisReinitAfterMs > 0) {
		let unhealthySince: number | null = null
		let busy = false
		const intervalMs = Math.min(5000, config.redisReinitAfterMs)
		const watchdog = setInterval(async () => {
			if (busy) return
			busy = true
			try {
				if (await isRedisHealthy()) {
					unhealthySince = null
					return
				}
				const now = Date.now()
				if (unhealthySince === null) {
					unhealthySince = now
					return
				}
				if (now - unhealthySince >= config.redisReinitAfterMs) {
					log.warn("redis unhealthy past threshold, recreating client", {
						unhealthy_ms: now - unhealthySince,
					})
					try {
						await reinitRedis()
						log.info("redis client reinitialized after outage")
						unhealthySince = null
					} catch (err: unknown) {
						const msg = err instanceof Error ? err.message : String(err)
						log.error("redis reinit failed, will retry", { error: msg })
						unhealthySince = now
					}
				}
			} finally {
				busy = false
			}
		}, intervalMs)
		// Don't let the watchdog keep the event loop alive on its own.
		watchdog.unref()
	}
}

main().catch((err) => {
	const message = err instanceof Error ? err.message : String(err)
	const stack = err instanceof Error ? err.stack : undefined
	log.error("failed to start", { error: message, stack })
	process.exit(1)
})
