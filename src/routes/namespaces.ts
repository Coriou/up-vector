import { type Context, Hono } from "hono";
import { getClient } from "../redis";
import { dropIndex } from "../translate/index";
import {
  deleteKeysByPattern,
  NS_REGISTRY,
  validateNamespace,
  vectorPrefix,
} from "../translate/keys";

export const namespaceRoutes = new Hono();

// List namespaces
const handleList = async (c: Context) => {
  const redis = getClient();
  const namespaces = await redis.smembers(NS_REGISTRY);
  return c.json({ result: namespaces });
};

namespaceRoutes.get("/list-namespaces", handleList);
namespaceRoutes.post("/list-namespaces", handleList);

// Delete namespace
const handleDeleteNamespace = async (c: Context) => {
  const ns = c.req.param("namespace");
  if (!ns) {
    return c.json({ error: "Namespace is required", status: 400 }, 400);
  }
  validateNamespace(ns);
  const redis = getClient();

  await dropIndex(ns);
  await deleteKeysByPattern(`${vectorPrefix(ns)}*`);
  await redis.srem(NS_REGISTRY, ns);

  return c.json({ result: "Success" });
};

namespaceRoutes.delete("/delete-namespace/:namespace", handleDeleteNamespace);
namespaceRoutes.post("/delete-namespace/:namespace", handleDeleteNamespace);
