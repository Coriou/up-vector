import { RedisClient } from "bun"
import { config } from "./config"
import { log } from "./logger"
import { advanceRedisGeneration, redisGeneration } from "./redis-generation"
import { guardRedisCommands } from "./request-context"

let client: RedisClient | null = null
let guardedClient: RedisClient | null = null
let lastPingOk = true
let lastPingTime = 0
let pendingPing: Promise<boolean> | null = null
const PING_CACHE_MS = 1000
// Bun.redis doesn't expose a per-command timeout, so the health probe wraps
// PING in Promise.race. Without this, a hung TCP connection (e.g. partitioned
// Redis) would block /health until the global request timeout fires.
const PING_TIMEOUT_MS = 2000

export function getClient(): RedisClient {
	if (!client) {
		throw new Error("Redis client not initialized. Call initRedis() first.")
	}
	return guardedClient ?? client
}

export async function initRedis(): Promise<void> {
	advanceRedisGeneration()
	lastPingTime = 0
	lastPingOk = false
	pendingPing = null
	client = new RedisClient(config.redisUrl, {
		connectionTimeout: 10_000,
		autoReconnect: true,
		maxRetries: 10,
		enableAutoPipelining: true,
		enableOfflineQueue: true,
	})

	guardedClient = guardRedisCommands(client)
	const initializedClient = client
	client.onconnect = () => {
		if (client === initializedClient) {
			advanceRedisGeneration()
			lastPingTime = 0
			pendingPing = null
		}
		log.info("redis connected")
	}
	client.onclose = (error) => {
		if (client === initializedClient) lastPingOk = false
		log.warn("redis disconnected", { error: error.message })
	}

	const pong = await client.ping()
	if (pong !== "PONG") {
		throw new Error(`Redis PING failed: ${pong}`)
	}
}

export async function isRedisHealthy(): Promise<boolean> {
	if (!client?.connected) return false
	if (pendingPing) return pendingPing
	if (Date.now() - lastPingTime < PING_CACHE_MS) return lastPingOk

	const probedClient = client
	const generation = redisGeneration()
	const probe = async (): Promise<boolean> => {
		let timer: Timer | undefined
		let healthy = false
		try {
			const pong = await Promise.race([
				probedClient.ping(),
				new Promise<null>((resolve) => {
					timer = setTimeout(() => resolve(null), PING_TIMEOUT_MS)
				}),
			])
			healthy = pong === "PONG"
		} catch {
			// A probe error only changes readiness; it does not prove disconnect.
		} finally {
			clearTimeout(timer)
		}
		if (client === probedClient && generation === redisGeneration()) {
			lastPingOk = healthy
			lastPingTime = Date.now()
		}
		return healthy
	}
	const pending = probe()
	pendingPing = pending
	try {
		return await pending
	} finally {
		if (pendingPing === pending) pendingPing = null
	}
}

/**
 * Recreate the Redis client after a terminal disconnect. Bun's RedisClient gives
 * up permanently once its reconnect attempts are exhausted ("Max reconnection
 * attempts reached") and never recovers on its own — verified against Redis
 * Stack: after a brief outage the old client stays wedged even once Redis is
 * back. A fresh client reconnects cleanly, so the watchdog calls this to
 * self-heal in-process. Throws if the new client can't reach Redis yet (caller
 * retries on the next tick).
 */
export async function reinitRedis(): Promise<boolean> {
	// A timed-out PING is not a terminal disconnect. Closing a slow but
	// connected client rejects its pending commands and prevents recovery.
	if (client?.connected) return false
	const old = client
	client = null
	if (old) {
		try {
			old.close()
		} catch {
			// Best-effort: the old client is already broken.
		}
	}
	await initRedis()
	return true
}

export async function closeRedis(): Promise<void> {
	if (client) {
		client.close()
		client = null
	}
}
