import { Hono } from "hono"

export const unsupportedRoutes = new Hono()

const resumableMessage =
	"Resumable query is not supported by up-vector yet. Use /query or /query-data, or run Upstash Vector for resumable cursors."

unsupportedRoutes.post("/resumable-query/:namespace?", (c) => {
	return c.json({ error: resumableMessage, status: 501 }, 501)
})

unsupportedRoutes.post("/resumable-query-data/:namespace?", (c) => {
	return c.json({ error: resumableMessage, status: 501 }, 501)
})

unsupportedRoutes.post("/resumable-query-next", (c) => {
	return c.json({ error: resumableMessage, status: 501 }, 501)
})

unsupportedRoutes.post("/resumable-query-end", (c) => {
	return c.json({ error: resumableMessage, status: 501 }, 501)
})
