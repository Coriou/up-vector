import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { log } from "../logger";

export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof HTTPException) {
    const message = err.message || "Unauthorized";
    return c.json({ error: message, status: err.status }, err.status);
  }

  if (err instanceof ZodError) {
    const message = err.issues.map((i) => i.message).join(", ");
    return c.json({ error: message, status: 400 }, 400);
  }

  log.error("unhandled error", {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  return c.json({ error: "Internal Server Error", status: 500 }, 500);
};
