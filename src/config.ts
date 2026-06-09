import { z } from "zod"
import type { DistanceMetric } from "./types"

// Hono's bearerAuth (RFC 6750) only accepts tokens matching this charset on the
// wire. If UPVECTOR_TOKEN contains a character outside this set, every
// authenticated request would be rejected as 400 Bad Request before the
// timing-safe comparison ever runs — silently un-authable. Validate at boot.
const BEARER_TOKEN_CHARSET = /^[A-Za-z0-9._~+/-]+=*$/

const envSchema = z
	.object({
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
		UPVECTOR_EMBEDDING_PROVIDER: z.enum(["disabled", "openai", "fake"]).default("disabled"),
		UPVECTOR_EMBEDDING_MODEL: z.string().min(1).default("text-embedding-3-small"),
		UPVECTOR_EMBEDDING_DIMENSION: z.coerce.number().int().positive().optional(),
		UPVECTOR_EMBEDDING_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
		UPVECTOR_EMBEDDING_API_KEY: z.string().optional(),
		UPVECTOR_EMBEDDING_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(10000),
		UPVECTOR_EMBEDDING_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
	})
	.superRefine((env, ctx) => {
		if (env.UPVECTOR_EMBEDDING_PROVIDER === "openai" && !env.UPVECTOR_EMBEDDING_API_KEY) {
			ctx.addIssue({
				code: "custom",
				path: ["UPVECTOR_EMBEDDING_API_KEY"],
				message: "UPVECTOR_EMBEDDING_API_KEY is required when UPVECTOR_EMBEDDING_PROVIDER=openai",
			})
		}
		if (
			env.UPVECTOR_DIMENSION !== undefined &&
			env.UPVECTOR_EMBEDDING_DIMENSION !== undefined &&
			env.UPVECTOR_DIMENSION !== env.UPVECTOR_EMBEDDING_DIMENSION
		) {
			ctx.addIssue({
				code: "custom",
				path: ["UPVECTOR_EMBEDDING_DIMENSION"],
				message: "UPVECTOR_EMBEDDING_DIMENSION must match UPVECTOR_DIMENSION when both are set",
			})
		}
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
	embeddingProvider: parsed.UPVECTOR_EMBEDDING_PROVIDER,
	embeddingModel: parsed.UPVECTOR_EMBEDDING_MODEL,
	embeddingDimension: parsed.UPVECTOR_EMBEDDING_DIMENSION as number | undefined,
	embeddingBaseUrl: parsed.UPVECTOR_EMBEDDING_BASE_URL,
	embeddingApiKey: parsed.UPVECTOR_EMBEDDING_API_KEY,
	embeddingTimeoutMs: parsed.UPVECTOR_EMBEDDING_TIMEOUT_MS,
	embeddingRetries: parsed.UPVECTOR_EMBEDDING_RETRIES,
}
