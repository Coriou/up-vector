# Sparse and Hybrid Architecture

Status: roadmap, not implemented. Still deferred as of 2026-07-17 (maintenance pass; no sparse/hybrid implementation).

up-vector is currently reliable for dense vectors and dense raw-text RAG via `/upsert-data` and `/query-data`. Sparse and hybrid support should not be added by simply accepting `sparseVector` fields; it needs a storage and scoring model that can be tested against Upstash semantics.

## Upstash Surface To Match

Upstash Vector supports three index types:

| Index type | Upsert shape | Query shape |
|------------|--------------|-------------|
| Dense | `vector` | `vector` or `data` when a dense embedding model exists |
| Sparse | `sparseVector` | `sparseVector` or `data` when a sparse embedding model exists |
| Hybrid | `vector` + `sparseVector` | dense+sparse query, `queryMode`, `fusionAlgorithm`, `weightingStrategy`, or `data` when hosted models exist |

The current SDK routes `upsert({ data })` to `/upsert-data` and `query({ data })` to `/query-data`. For hybrid indexes, Upstash-hosted models can produce both dense and sparse vectors from raw text. up-vector does not implement that hosted model catalog.

## Redis Data Model

Keep the existing dense hash fields and add sparse fields without changing existing dense keys:

```
Key:    v:{namespace}:{id}
Fields:
  id        -> string
  vec       -> dense Float32 binary blob
  _vec      -> dense Float32 base64 mirror for fetch/query output
  metadata  -> JSON string
  data      -> raw text
  sidx      -> sparse Int32 binary blob
  _sidx     -> JSON/base64 mirror for fetch/query output
  sval      -> sparse Float32 binary blob
  _sval     -> JSON/base64 mirror for fetch/query output
```

Sparse-specific inverted index keys:

```
sp:{namespace}:df:{termIndex}      -> integer document frequency
sp:{namespace}:post:{termIndex}    -> sorted set, member id, score sparse value
sp:{namespace}:docs                -> set of ids with sparse vectors
```

This keeps namespace isolation explicit and lets dense-only data remain readable after an upgrade.

## Sparse Scoring

Sparse query scoring should be exact over posting lists, not approximate HNSW:

1. Validate `indices.length === values.length`.
2. For each query dimension, read `sp:{ns}:post:{idx}`.
3. Accumulate dot product: `score[id] += queryValue * docValue`.
4. Apply optional `weightingStrategy: "IDF"` to query terms.

IDF weighting:

```
idf(term) = log((1 + totalDocs) / (1 + documentFrequency(term))) + 1
weightedQueryValue = queryValue * idf(term)
```

This is testable and maps naturally to BM25/SPLADE-style sparse vectors, but it is not enough by itself to claim Upstash sparse parity until edge cases are compared against the official service and SDK behavior.

## Hybrid Fusion

Hybrid query must run dense and sparse searches independently, then fuse ranked lists.

Supported query modes to design for:

| queryMode | Behavior |
|-----------|----------|
| `HYBRID` | Run both dense and sparse, then fuse |
| `DENSE` | Run dense component only |
| `SPARSE` | Run sparse component only |

Fusion algorithms:

RRF:

```
rrfScore(id) = sum(1 / (k + rank_component(id)))
```

DBSF:

Normalize dense and sparse scores independently by distribution, then add normalized scores. This requires careful handling for small result sets, tied scores, empty components, and negative sparse scores.

Do not expose `fusionAlgorithm: "DBSF"` until tests cover these cases.

## Metadata Filtering

The current dense implementation over-fetches candidates from RediSearch and applies the Upstash-like filter parser in application code. Sparse and hybrid should reuse the same parser/evaluator.

Candidate selection options:

| Mode | Candidate source | Filter timing |
|------|------------------|---------------|
| Sparse | Posting-list accumulated ids | Evaluate metadata before final topK |
| Hybrid | Union of dense and sparse candidate ids | Evaluate before fusion if possible, otherwise after component ranking |

Highly selective filters can return fewer than `topK`, which Upstash also documents as possible when filter budgets are exceeded.

## Updates, Deletes, Resets

Every mutation must update both document hashes and sparse secondary keys atomically enough to avoid orphaned postings.

Required behavior:

- Upsert sparse vector: remove old postings for that id, write new postings, update `df` counters.
- Update sparse vector: same as sparse upsert, but only when `sparseVector` is present.
- Delete ids/prefix/filter: remove hashes and all sparse postings for matching ids.
- Reset namespace: delete `v:{ns}:*`, `idx:{ns}`, and `sp:{ns}:*`.
- Rename namespace: move hashes, rebuild RediSearch dense index, and rebuild sparse posting lists under the new namespace.

For correctness, keep a per-id sparse index list in the hash (`sidx`) so deletes do not need a global scan over all posting lists.

## Migration

Existing dense data can stay in place:

1. Dense-only hashes remain valid.
2. New sparse fields are optional.
3. A namespace's effective index type should be recorded separately, for example `idxmeta:{ns}` with `indexType`, dense dimension, metric, and sparse model metadata.
4. Mixed historical data should be treated as partial until backfilled; hybrid query should ignore missing components rather than fabricate scores.

Migration command sketch:

```
SCAN v:{ns}:*
  HGETALL
  if data exists and sparse provider configured:
    embed sparse data
    write postings
  else leave dense-only
```

## Open Questions

- Exact Upstash sparse score normalization for user-provided sparse vectors.
- Whether SDK mixed `queryMany` batches containing both `data` and `vector` are accepted by Upstash's `/query-data`.
- DBSF details for small candidate sets and tied scores.
- Whether a RedisJSON-based metadata model is worth the migration cost before sparse/hybrid work.

Until these are resolved with official docs, SDK source, and compatibility tests, sparse and hybrid should remain explicit unsupported behavior.
