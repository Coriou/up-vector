import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { awaitIndexed, createIndex, randomVector } from "./setup";

const index = createIndex();
const DIM = 384;

describe("SDK: query", () => {
  const baseVec = randomVector(DIM);

  beforeAll(async () => {
    await index.reset({ all: true });
    await index.upsert([
      {
        id: "q1",
        vector: baseVec,
        metadata: { type: "animal", diet: "carnivore", pop: 900 },
      },
      {
        id: "q2",
        vector: randomVector(DIM),
        metadata: { type: "animal", diet: "herbivore", pop: 500 },
      },
      {
        id: "q3",
        vector: randomVector(DIM),
        metadata: { type: "plant", diet: "none", pop: 0 },
      },
      {
        id: "q4",
        vector: randomVector(DIM),
        metadata: { type: "animal", diet: "omnivore", pop: 300 },
      },
      {
        id: "q5",
        vector: randomVector(DIM),
        metadata: { type: "mineral", pop: 0 },
      },
    ]);
    await awaitIndexed();
  });

  afterAll(() => index.reset({ all: true }));

  test("should return scored results ordered by similarity", async () => {
    const results = await index.query({ vector: baseVec, topK: 5 });
    expect(results.length).toBe(5);
    expect(results[0].id).toBe("q1"); // exact match
    expect(results[0].score).toBeGreaterThan(0.9);
    // Scores should be descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
    }
  });

  test("should respect topK limit", async () => {
    const results = await index.query({ vector: baseVec, topK: 2 });
    expect(results.length).toBe(2);
  });

  test("should include metadata when requested", async () => {
    const results = await index.query({
      vector: baseVec,
      topK: 1,
      includeMetadata: true,
    });
    expect(results[0].metadata).toBeDefined();
    expect((results[0].metadata as { type: string }).type).toBe("animal");
  });

  test("should not include metadata when not requested", async () => {
    const results = await index.query({
      vector: baseVec,
      topK: 1,
      includeMetadata: false,
    });
    expect(results[0].metadata).toBeUndefined();
  });

  test("should include vectors when requested", async () => {
    const results = await index.query({
      vector: baseVec,
      topK: 1,
      includeVectors: true,
    });
    expect(results[0].vector).toBeDefined();
    expect(results[0].vector?.length).toBe(DIM);
  });

  test("should filter with equality", async () => {
    const results = await index.query({
      vector: baseVec,
      topK: 10,
      filter: "type = 'animal'",
      includeMetadata: true,
    });
    expect(results.length).toBe(3);
    for (const r of results) {
      expect((r.metadata as { type: string }).type).toBe("animal");
    }
  });

  test("should filter with numeric comparison", async () => {
    const results = await index.query({
      vector: baseVec,
      topK: 10,
      filter: "pop >= 500",
      includeMetadata: true,
    });
    for (const r of results) {
      expect((r.metadata as { pop: number }).pop).toBeGreaterThanOrEqual(500);
    }
  });

  test("should filter with IN operator", async () => {
    const results = await index.query({
      vector: baseVec,
      topK: 10,
      filter: "diet IN ('carnivore', 'herbivore')",
      includeMetadata: true,
    });
    for (const r of results) {
      const diet = (r.metadata as { diet: string }).diet;
      expect(["carnivore", "herbivore"]).toContain(diet);
    }
  });

  test("should filter with compound AND", async () => {
    const results = await index.query({
      vector: baseVec,
      topK: 10,
      filter: "type = 'animal' AND pop >= 500",
      includeMetadata: true,
    });
    for (const r of results) {
      expect((r.metadata as { type: string }).type).toBe("animal");
      expect((r.metadata as { pop: number }).pop).toBeGreaterThanOrEqual(500);
    }
  });

  test("should return empty for impossible filter", async () => {
    const results = await index.query({
      vector: baseVec,
      topK: 10,
      filter: "type = 'nonexistent'",
    });
    expect(results.length).toBe(0);
  });

  test("should query in namespace", async () => {
    const ns = index.namespace("query-ns");
    const vec = randomVector(DIM);
    await ns.upsert({ id: "ns-q1", vector: vec });
    await awaitIndexed();

    const results = await ns.query({ vector: vec, topK: 5 });
    expect(results.length).toBe(1);
    expect(results[0].id).toBe("ns-q1");

    await ns.reset();
  });

  test("should handle batch queries (queryMany)", async () => {
    const results = await index.queryMany([
      { vector: baseVec, topK: 2, includeMetadata: true },
      { vector: randomVector(DIM), topK: 3 },
    ]);
    expect(results.length).toBe(2);
    expect(results[0].length).toBe(2);
    expect(results[1].length).toBe(3);
    expect(results[0][0].metadata).toBeDefined();
    expect(results[1][0].metadata).toBeUndefined();
  });
});
