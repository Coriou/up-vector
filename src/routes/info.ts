import { type Context, Hono } from "hono";
import { config } from "../config";
import { getClient } from "../redis";
import { getDetectedDimension, parseNumDocs } from "../translate/index";
import { indexName, NS_REGISTRY } from "../translate/keys";

export const infoRoutes = new Hono();

const handleInfo = async (c: Context) => {
  const redis = getClient();
  const namespaceNames = await redis.smembers(NS_REGISTRY);

  // Ensure default namespace is always included (Upstash always returns it)
  const allNamespaces = namespaceNames.includes("")
    ? namespaceNames
    : ["", ...namespaceNames];

  const namespaces: Record<
    string,
    { vectorCount: number; pendingVectorCount: number }
  > = {};
  let totalVectorCount = 0;
  let detectedDimension = config.dimension ?? 0;

  // Fetch vector counts in parallel (auto-pipelined by Bun.redis)
  const infos = await Promise.all(
    allNamespaces.map(async (ns) => {
      let vectorCount = 0;
      try {
        const info = (await redis.send("FT.INFO", [
          indexName(ns),
        ])) as unknown[];
        vectorCount = parseNumDocs(info);
      } catch {
        // Index might not exist (namespace registered but no vectors upserted yet)
      }
      return { ns, vectorCount };
    }),
  );

  for (const { ns, vectorCount } of infos) {
    namespaces[ns] = { vectorCount, pendingVectorCount: 0 };
    totalVectorCount += vectorCount;

    if (detectedDimension === 0) {
      const dim = getDetectedDimension(ns);
      if (dim !== undefined) detectedDimension = dim;
    }
  }

  return c.json({
    result: {
      vectorCount: totalVectorCount,
      pendingVectorCount: 0,
      dimension: detectedDimension,
      similarityFunction: config.metric,
      namespaces,
    },
  });
};

infoRoutes.get("/info", handleInfo);
infoRoutes.post("/info", handleInfo);
