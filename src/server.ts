import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { config } from "./config";
import { authMiddleware } from "./middleware/auth";
import { errorHandler } from "./middleware/error-handler";
import { loggerMiddleware } from "./middleware/logger";
import { timeoutMiddleware } from "./middleware/timeout";
import { deleteRoutes } from "./routes/delete";
import { fetchRoutes } from "./routes/fetch";
import { healthRoutes } from "./routes/health";
import { infoRoutes } from "./routes/info";
import { namespaceRoutes } from "./routes/namespaces";
import { queryRoutes } from "./routes/query";
import { rangeRoutes } from "./routes/range";
import { resetRoutes } from "./routes/reset";
import { updateRoutes } from "./routes/update";
import { upsertRoutes } from "./routes/upsert";

const app = new Hono();

// Global error handler
app.onError(errorHandler);

// Logger on all routes
app.use(loggerMiddleware);

// Health check BEFORE auth (no token needed)
app.route("/", healthRoutes);

// Metrics endpoint (before auth, unauthenticated for Prometheus scraping)
if (config.metricsEnabled) {
  const { metricsRoutes } = await import("./routes/metrics");
  app.route("/", metricsRoutes);
}

// Auth on all remaining routes
app.use("/*", authMiddleware);

// Body size limit (16 MB) — protect against memory exhaustion
app.use(
  "/*",
  bodyLimit({
    maxSize: 16 * 1024 * 1024,
    onError: (c) => {
      return c.json({ error: "Request body too large", status: 413 }, 413);
    },
  }),
);

// Request timeout on business routes only
app.use("/*", timeoutMiddleware);

// Authenticated routes
app.route("/", upsertRoutes);
app.route("/", queryRoutes);
app.route("/", fetchRoutes);
app.route("/", deleteRoutes);
app.route("/", updateRoutes);
app.route("/", rangeRoutes);
app.route("/", resetRoutes);
app.route("/", infoRoutes);
app.route("/", namespaceRoutes);

// 404 handler
app.notFound((c) => {
  return c.json({ error: "Not Found", status: 404 }, 404);
});

export { app };
