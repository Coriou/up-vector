import { type Context, Hono } from "hono";
import { getClient } from "../redis";
import { dropIndex } from "../translate/index";
import {
  deleteKeysByPattern,
  NS_REGISTRY,
  validateNamespace,
  vectorPrefix,
} from "../translate/keys";

export const resetRoutes = new Hono();

const handleReset = async (c: Context) => {
  const ns = c.req.param("namespace") ?? "";
  validateNamespace(ns);
  const all = c.req.query("all") !== undefined;
  const redis = getClient();

  if (all) {
    // Reset all namespaces
    const namespaces = await redis.smembers(NS_REGISTRY);

    // Also discover any orphaned indexes not in the registry
    let allIndexes: string[] = [];
    try {
      allIndexes = (await redis.send("FT._LIST", [])) as string[];
    } catch {
      // FT._LIST may not be available in older Redis versions
    }

    // Drop registered namespace indexes
    await Promise.all(namespaces.map((n) => dropIndex(n)));

    // Drop any orphaned idx:* indexes not already dropped
    const droppedSet = new Set(namespaces.map((n) => `idx:${n}`));
    for (const idx of allIndexes) {
      if (idx.startsWith("idx:") && !droppedSet.has(idx)) {
        const orphanNs = idx.slice(4);
        await dropIndex(orphanNs);
      }
    }

    await deleteKeysByPattern("v:*");
    await redis.del(NS_REGISTRY);
  } else {
    // Reset single namespace
    await dropIndex(ns);
    await deleteKeysByPattern(`${vectorPrefix(ns)}*`);
    await redis.srem(NS_REGISTRY, ns);
  }

  return c.json({ result: "Success" });
};

resetRoutes.post("/reset/:namespace?", handleReset);
resetRoutes.delete("/reset/:namespace?", handleReset);
