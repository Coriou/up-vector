import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { config } from "./config"
import { authMiddleware } from "./middleware/auth"
import { errorHandler } from "./middleware/error-handler"
import { loggerMiddleware } from "./middleware/logger"
import { timeoutMiddleware } from "./middleware/timeout"
import { deleteRoutes } from "./routes/delete"
import { fetchRoutes } from "./routes/fetch"
import { healthRoutes } from "./routes/health"
import { infoRoutes } from "./routes/info"
import { namespaceRoutes } from "./routes/namespaces"
import { queryRoutes } from "./routes/query"
import { rangeRoutes } from "./routes/range"
import { resetRoutes } from "./routes/reset"
import { updateRoutes } from "./routes/update"
import { upsertRoutes } from "./routes/upsert"

const app = new Hono()

// Global error handler
app.onError(errorHandler)

// Default security headers for every response. These are cheap defense-in-depth
// and harmless for an API that only ever returns JSON / plain text.
app.use(async (c, next) => {
	await next()
	c.header("X-Content-Type-Options", "nosniff")
	c.header("Referrer-Policy", "no-referrer")
	c.header("Cache-Control", "no-store")
})

// Logger on all routes
app.use(loggerMiddleware)

// Health check BEFORE auth (no token needed)
app.route("/", healthRoutes)

// Metrics endpoint (before auth, unauthenticated for Prometheus scraping)
if (config.metricsEnabled) {
	const { metricsRoutes } = await import("./routes/metrics")
	app.route("/", metricsRoutes)
}

// Auth on all remaining routes
app.use("/*", authMiddleware)

// Body size limit (configurable, default 32 MiB) — protect against memory
// exhaustion while still allowing max-batch upserts (1000 × 1536-dim ≈ 23 MB).
app.use(
	"/*",
	bodyLimit({
		maxSize: config.maxBodySize,
		onError: (c) => {
			return c.json({ error: "Request body too large", status: 413 }, 413)
		},
	}),
)

// Request timeout on business routes only
app.use("/*", timeoutMiddleware)

// Authenticated routes
app.route("/", upsertRoutes)
app.route("/", queryRoutes)
app.route("/", fetchRoutes)
app.route("/", deleteRoutes)
app.route("/", updateRoutes)
app.route("/", rangeRoutes)
app.route("/", resetRoutes)
app.route("/", infoRoutes)
app.route("/", namespaceRoutes)

// 404 handler
app.notFound((c) => {
	return c.json({ error: "Not Found", status: 404 }, 404)
})

export { app }
