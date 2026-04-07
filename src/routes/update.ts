import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { getClient } from "../redis";
import { getDetectedDimension } from "../translate/index";
import { validateId, validateNamespace, vectorKey } from "../translate/keys";
import { encodeVector, encodeVectorBase64 } from "../translate/vectors";

const UpdateBody = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  vector: z.array(z.number()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  data: z.string().optional(),
  metadataUpdateMode: z.enum(["OVERWRITE", "PATCH"]).default("OVERWRITE"),
});

export const updateRoutes = new Hono();

updateRoutes.post("/update/:namespace?", async (c) => {
  const body = await c.req.json();
  const parsed = UpdateBody.parse(body);
  const ns = c.req.param("namespace") ?? "";
  validateNamespace(ns);
  validateId(parsed.id);
  const redis = getClient();
  const key = vectorKey(ns, parsed.id);

  // Check if vector exists
  const exists = await redis.exists(key);
  if (!exists) {
    return c.json({ result: { updated: 0 } });
  }

  // Build HSET args — must use send("HSET") for binary vec field
  const args: (string | Buffer)[] = [key];

  // Update vector if provided
  if (parsed.vector) {
    if (parsed.vector.length === 0) {
      throw new HTTPException(400, {
        message: "Vector dimension must be at least 1",
      });
    }
    const existingDim = getDetectedDimension(ns);
    if (existingDim !== undefined && parsed.vector.length !== existingDim) {
      throw new HTTPException(400, {
        message: `Dimension mismatch: namespace expects ${existingDim}, got ${parsed.vector.length}`,
      });
    }
    args.push(
      "vec",
      encodeVector(parsed.vector),
      "_vec",
      encodeVectorBase64(parsed.vector),
    );
  }

  // Update metadata if provided
  if (parsed.metadata !== undefined) {
    if (parsed.metadataUpdateMode === "PATCH") {
      const existing = await redis.hget(key, "metadata");
      let base: Record<string, unknown> = {};
      if (existing) {
        try {
          base = JSON.parse(existing);
        } catch {
          // Malformed existing metadata — start fresh
        }
      }
      args.push("metadata", JSON.stringify({ ...base, ...parsed.metadata }));
    } else {
      args.push("metadata", JSON.stringify(parsed.metadata));
    }
  }

  // Update data if provided
  if (parsed.data !== undefined) {
    args.push("data", parsed.data);
  }

  if (args.length > 1) {
    await redis.send("HSET", args as string[]);
  }

  return c.json({ result: { updated: 1 } });
});
