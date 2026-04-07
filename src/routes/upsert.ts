import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { getClient } from "../redis";
import {
  ensureIndex,
  getDetectedDimension,
  setDetectedDimension,
} from "../translate/index";
import { NS_REGISTRY, vectorKey } from "../translate/keys";
import { encodeVector, encodeVectorBase64 } from "../translate/vectors";

const VectorSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  vector: z.array(z.number()),
  metadata: z.record(z.string(), z.unknown()).optional(),
  data: z.string().optional(),
});

const UpsertBody = z.union([VectorSchema, z.array(VectorSchema)]);

export const upsertRoutes = new Hono();

upsertRoutes.post("/upsert/:namespace?", async (c) => {
  const body = await c.req.json();
  const parsed = UpsertBody.parse(body);
  const vectors = Array.isArray(parsed) ? parsed : [parsed];

  if (vectors.length === 0) {
    return c.json({ result: "Success" });
  }

  const ns = c.req.param("namespace") ?? "";
  const redis = getClient();

  // Validate dimension consistency within the batch
  const dim = vectors[0].vector.length;
  if (dim === 0) {
    throw new HTTPException(400, {
      message: "Vector dimension must be at least 1",
    });
  }
  for (const v of vectors) {
    if (v.vector.length !== dim) {
      throw new HTTPException(400, {
        message: `Dimension mismatch in batch: expected ${dim}, got ${v.vector.length}`,
      });
    }
  }

  // Validate against existing namespace dimension
  const existingDim = getDetectedDimension(ns);
  if (existingDim !== undefined && existingDim !== dim) {
    throw new HTTPException(400, {
      message: `Dimension mismatch: namespace expects ${existingDim}, got ${dim}`,
    });
  }

  // Ensure the RediSearch index exists
  await ensureIndex(ns, dim);
  setDetectedDimension(ns, dim);

  // Upsert all vectors (auto-pipelined via Promise.all)
  // Must use send("HSET") instead of redis.hset() because hset() UTF-8 encodes
  // Buffer values, corrupting the binary vec blob that RediSearch needs.
  await Promise.all(
    vectors.map((v) => {
      const key = vectorKey(ns, v.id);
      const args: (string | Buffer)[] = [
        key,
        "id",
        v.id,
        "vec",
        encodeVector(v.vector),
        "_vec",
        encodeVectorBase64(v.vector),
      ];
      if (v.metadata !== undefined) {
        args.push("metadata", JSON.stringify(v.metadata));
      }
      if (v.data !== undefined) {
        args.push("data", v.data);
      }
      return redis.send("HSET", args as string[]);
    }),
  );

  // Register namespace
  await redis.sadd(NS_REGISTRY, ns);

  return c.json({ result: "Success" });
});
