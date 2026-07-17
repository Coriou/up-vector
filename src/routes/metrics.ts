import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { config } from "../config"
import { formatMetrics } from "../metrics"

export function metricsAuthorizationOk(
	authorizationHeader: string | undefined,
	token: string | undefined,
): boolean {
	if (!token) return true
	return authorizationHeader === `Bearer ${token}`
}

export function assertMetricsAuthorized(
	authorizationHeader: string | undefined,
	token: string | undefined,
): void {
	if (!metricsAuthorizationOk(authorizationHeader, token)) {
		throw new HTTPException(401, { message: "Unauthorized" })
	}
}

export const metricsRoutes = new Hono()

metricsRoutes.get("/metrics", (c) => {
	assertMetricsAuthorized(c.req.header("Authorization"), config.metricsToken)
	return c.text(formatMetrics(), 200, {
		"Content-Type": "text/plain; version=0.0.4; charset=utf-8",
	})
})
