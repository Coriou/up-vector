import { z } from "zod"
import type { DistanceMetric } from "./types"

// Hono's bearerAuth (RFC 6750) only accepts tokens matching this charset on the
// wire. If UPVECTOR_TOKEN contains a character outside this set, every
// authenticated request would be rejected as 400 Bad Request before the
// timing-safe comparison ever runs — silently un-authable. Validate at boot.
const BEARER_TOKEN_CHARSET = /^[A-Za-z0-9._~+/-]+=*$/

const envSchema = z.object({
	UPVECTOR_TOKEN: z
		.string()
		.min(1, "UPVECTOR_TOKEN is required")
		.refine(
			(t) => BEARER_TOKEN_CHARSET.test(t),
			"UPVECTOR_TOKEN must only contain RFC 6750 bearer token characters: [A-Za-z0-9._~+/-]+=*",
		),
	UPVECTOR_REDIS_URL: z.string().default("redis://localhost:6379"),
	UPVECTOR_PORT: z.coerce.number().int().positive().default(8080),
	UPVECTOR_HOST: z.string().default("0.0.0.0"),
	UPVECTOR_DIMENSION: z.coerce.number().int().positive().optional(),
	UPVECTOR_METRIC: z.enum(["COSINE", "EUCLIDEAN", "DOT_PRODUCT"]).default("COSINE"),
	UPVECTOR_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
	UPVECTOR_LOG_FORMAT: z.enum(["json", "text"]).default("json"),
	UPVECTOR_SHUTDOWN_TIMEOUT: z.coerce.number().int().nonnegative().default(30000),
	UPVECTOR_REQUEST_TIMEOUT: z.coerce.number().int().nonnegative().default(30000),
	UPVECTOR_METRICS: z.enum(["true", "false"]).default("false"),
	// 32 MiB default — covers a max upsert batch (1000 vectors × 1536 dims as JSON
	// is ~23 MB) with headroom for metadata.
	UPVECTOR_MAX_BODY_SIZE: z.coerce
		.number()
		.int()
		.positive()
		.default(32 * 1024 * 1024),
})

const parsed = envSchema.parse(process.env)

export const config = {
	token: parsed.UPVECTOR_TOKEN,
	redisUrl: parsed.UPVECTOR_REDIS_URL,
	port: parsed.UPVECTOR_PORT,
	host: parsed.UPVECTOR_HOST,
	dimension: parsed.UPVECTOR_DIMENSION as number | undefined,
	metric: parsed.UPVECTOR_METRIC as DistanceMetric,
	logLevel: parsed.UPVECTOR_LOG_LEVEL,
	logFormat: parsed.UPVECTOR_LOG_FORMAT,
	shutdownTimeout: parsed.UPVECTOR_SHUTDOWN_TIMEOUT,
	requestTimeout: parsed.UPVECTOR_REQUEST_TIMEOUT,
	metricsEnabled: parsed.UPVECTOR_METRICS === "true",
	maxBodySize: parsed.UPVECTOR_MAX_BODY_SIZE,
}
