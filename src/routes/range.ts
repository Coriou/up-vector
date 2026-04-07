import { Hono } from "hono";
import { z } from "zod";
import { getClient } from "../redis";
import {
  parseVectorKey,
  validateNamespace,
  vectorPrefix,
} from "../translate/keys";
import { decodeVectorBase64 } from "../translate/vectors";
import type { Vector } from "../types";

const RangeBody = z.object({
  cursor: z
    .union([z.string(), z.number()])
    .transform(String)
    .refine((s) => s === "" || s === "0" || /^[1-9]\d*$/.test(s), {
      message: "Cursor must be a non-negative integer or empty string",
    }),
  limit: z.number().int().positive().max(1000),
  prefix: z.string().optional(),
  includeMetadata: z.boolean().default(false),
  includeVectors: z.boolean().default(false),
  includeData: z.boolean().default(false),
});

const MAX_SCAN_ITERATIONS = 10_000;

export const rangeRoutes = new Hono();

rangeRoutes.post("/range/:namespace?", async (c) => {
  const body = await c.req.json();
  const parsed = RangeBody.parse(body);
  const ns = c.req.param("namespace") ?? "";
  validateNamespace(ns);
  const redis = getClient();

  const basePrefix = vectorPrefix(ns);
  const pattern = parsed.prefix
    ? `${basePrefix}${parsed.prefix}*`
    : `${basePrefix}*`;

  // Accumulate results across multiple SCANs until we have `limit` keys
  // or the cursor wraps to "0" (scan complete).
  // Redis SCAN COUNT is only a hint — a single call may return fewer.
  let scanCursor = parsed.cursor === "" ? 0 : Number(parsed.cursor);
  const collectedKeys: string[] = [];
  const seenKeys = new Set<string>();
  let lastRawCursor = "0";
  let iterations = 0;

  do {
    if (++iterations > MAX_SCAN_ITERATIONS) break;
    const result = await redis.scan(
      scanCursor,
      "MATCH",
      pattern,
      "COUNT",
      parsed.limit,
    );
    const [rawCursor, keys] = result as unknown as [string, string[]];
    lastRawCursor = String(rawCursor);

    for (const key of keys) {
      if (collectedKeys.length >= parsed.limit) break;
      // SCAN can return duplicate keys across iterations — deduplicate
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      collectedKeys.push(key);
    }

    scanCursor = Number(lastRawCursor);
    if (collectedKeys.length >= parsed.limit) break;
  } while (lastRawCursor !== "0");

  // Fetch details for each matched key
  const vectors: Vector[] = await Promise.all(
    collectedKeys.map(async (key) => {
      const hash = await redis.hgetall(key);
      const parsedKey = parseVectorKey(key);
      const id = parsedKey?.id ?? hash?.id ?? key;

      const vec: Vector = { id };
      if (parsed.includeVectors && hash?._vec) {
        vec.vector = decodeVectorBase64(hash._vec);
      }
      if (parsed.includeMetadata && hash?.metadata) {
        try {
          vec.metadata = JSON.parse(hash.metadata);
        } catch {
          // Malformed metadata JSON — skip
        }
      }
      if (parsed.includeData && hash?.data !== undefined) {
        vec.data = hash.data;
      }
      return vec;
    }),
  );

  // Map Redis done-cursor ("0") to Upstash done-signal ("")
  const nextCursor = lastRawCursor === "0" ? "" : lastRawCursor;

  return c.json({ result: { nextCursor, vectors } });
});
