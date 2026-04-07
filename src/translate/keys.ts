import { getClient } from "../redis";

export const NS_REGISTRY = "_ns_registry";
const MAX_SCAN_ITERATIONS = 10_000;

const MAX_NAMESPACE_LENGTH = 256;
const MAX_ID_LENGTH = 1024;

/** Validates that a namespace name won't corrupt the key scheme */
export function validateNamespace(ns: string): void {
  if (ns.includes(":")) {
    throw new Error("Namespace name must not contain ':'");
  }
  if (ns.length > MAX_NAMESPACE_LENGTH) {
    throw new Error(
      `Namespace name must not exceed ${MAX_NAMESPACE_LENGTH} characters`,
    );
  }
}

/** Validates that an ID is non-empty and not too long */
export function validateId(id: string): void {
  if (id === "") {
    throw new Error("Vector ID must not be empty");
  }
  if (id.length > MAX_ID_LENGTH) {
    throw new Error(`Vector ID must not exceed ${MAX_ID_LENGTH} characters`);
  }
}

export function vectorKey(ns: string, id: string): string {
  return `v:${ns}:${id}`;
}

export function vectorPrefix(ns: string): string {
  return `v:${ns}:`;
}

export function indexName(ns: string): string {
  return `idx:${ns}`;
}

export function parseVectorKey(key: string): { ns: string; id: string } | null {
  if (!key.startsWith("v:")) return null;
  // Format: v:{ns}:{id} — ns never contains ":", but id can
  const afterV = key.slice(2); // remove "v:"
  const colonIdx = afterV.indexOf(":");
  if (colonIdx === -1) return null;
  return {
    ns: afterV.slice(0, colonIdx),
    id: afterV.slice(colonIdx + 1),
  };
}

export async function deleteKeysByPattern(pattern: string): Promise<number> {
  const redis = getClient();
  let cursor = "0";
  let totalDeleted = 0;
  const seen = new Set<string>();
  let iterations = 0;
  do {
    if (++iterations > MAX_SCAN_ITERATIONS) break;
    const result = await redis.scan(
      Number(cursor),
      "MATCH",
      pattern,
      "COUNT",
      100,
    );
    const [next, keys] = result as unknown as [string, string[]];
    // SCAN can return duplicate keys across iterations — deduplicate
    const unique = keys.filter((k) => !seen.has(k));
    for (const k of unique) seen.add(k);
    if (unique.length > 0) {
      totalDeleted += await redis.del(...unique);
    }
    cursor = String(next);
  } while (cursor !== "0");
  return totalDeleted;
}
