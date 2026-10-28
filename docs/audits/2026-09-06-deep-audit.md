# Deep Audit — 2026-09-06

Second run of the deep-audit workflowz, now packaged as a deterministic
procedure: `docs/workflows/deep-audit.md`. Method: 5 mutually-blind finder
agents (protocol correctness, security, resource safety, Upstash parity,
concurrency/self-heal) produced **17 raw findings**; each was attacked by a
dedicated skeptic prompted to refute with default-refute. **12 survived**
with concrete evidence; 5 were refuted. The orchestrator personally
re-verified the highest-severity survivors and every refutation that
overturned a framework-behavior claim (hono compose error propagation was
confirmed against the installed `node_modules/hono/dist/compose.js`).

## Confirmed findings and dispositions

| # | Severity | Dimension | Finding | Disposition |
|---|---|---|---|---|
| 1 | high | resource | `src/routes/query.ts` — FT.SEARCH had no RETURN/NOCONTENT projection: every KNN candidate shipped its full hash (`_vec` base64 + metadata ≤128KB + data ≤1MB) even with include* flags false; ~1.2GB through the RESP3 parser per topK=1000 query, ×100 in a batch | **Fixed**: conditional `RETURN` projection (`_score` always; `metadata` when filtering/includeMetadata; `_vec`/`data` per flags). NOCONTENT is unsafe — the parser reads `_score` from returned attributes. Pinned by `tests/unit/query-projection.test.ts`. |
| 2 | moderate | protocol | `src/translate/index.ts` — syncIndexes adopted ALL indexes from FT._LIST; a foreign app's vector index with a different DISTANCE_METRIC on a shared Redis aborted startup | **Fixed**: only `idx:*` indexes are synced/validated/cached, matching the prefix filter used everywhere else FT._LIST is consumed. Pinned by `tests/unit/sync-indexes.test.ts`. Refuter narrowed the trigger: only foreign *vector* indexes abort (non-vector indexes skip both checks); only metric mismatch is fatal from syncIndexes (wantDim is undefined there). |
| 3 | moderate | security/resource | `src/routes/update.ts`, `src/routes/data.ts` — /update (metadata + data) and /upsert-data (metadata) bypassed the per-entry budgets /upsert enforces "regardless of entry point" | **Fixed**: `MAX_METADATA_BYTES`/`MAX_DATA_LENGTH` exported from upsert.ts and applied to UpdateBody and UpsertDataItem. Pinned by `tests/unit/entry-point-limits.test.ts`. Residual: PATCH-mode merges accumulate in Lua across requests, each request individually within budget — flagged for the deferred Lua-level cap decision. |
| 4 | moderate | concurrency | `src/routes/reset.ts` — reset's dropIndex vs concurrent upsert leaves a bounded unindexed window (invisible to /query, visible to /fetch) | **Open** → [#24](https://github.com/Coriou/up-vector/issues/24). Candidate fix (stop dropping the index on namespace reset) makes namespace dimension sticky — a deliberate behavior decision, not a drive-by. Finder's "permanent stale knownIndexes" variant refuted (single multiplexed connection cannot invert reply order). |
| 5 | moderate | security | `src/server.ts` — chunked bodies are fully buffered by bodyLimit before the request timeout starts; the drip phase is bounded only by Bun's idleTimeout, and no concurrent-request limit exists | **Open** → [#22](https://github.com/Coriou/up-vector/issues/22). Refuter corrected impact: memory is capped at maxSize per connection; the unbounded axis is time. Authenticated-only. |
| 6 | moderate | concurrency | `src/middleware/logger.ts` — metrics allegedly skipped all thrown-error responses | **REFUTED** (contradicted-by-code): hono 4.13.3 `compose.js` catches at the throwing frame, runs `onError` there, and resolves `next()` normally — `recordRequest` runs for 400/401/500 responses with correct status. The finder's Hono semantics premise was false; the orchestrator's own first verification was also wrong and the refuter caught it. |
| 7 | moderate | resource | `src/routes/range.ts` — double Set + O(N) scan/sort per /range request | **REFUTED** (scope-decision): committed, deliberately deferred /range redesign (PLAN.md; docs/superpowers/specs/2026-07-17). Residual accepted: the redundant `seenKeys` Set was removed (behavior-preserving, pinned dedup test stays green) to be folded into the future /range item. |
| 8 | moderate | parity | `src/routes/query.ts` — empty filter string rejected 400 vs Upstash's documented `""` = no filter | **REFUTED** (pinned-by-test, deliberate anti-client-bug decision). Residual fixed: README compatibility table now documents the deviation. |
| 9 | low | protocol | `src/embedding.ts` — parseEmbedding enforced only Number.isFinite; provider values like 1e39 encoded to Infinity bytes with HTTP 200 via /upsert-data, /query-data, and embedded /update | **Fixed**: FLOAT32_MAX bound → 502 EmbeddingProviderError. Pinned in `tests/unit/embedding.test.ts`. Refuter widened blast radius to /query-data embeddings (same path, now covered). |
| 10 | low | protocol+security+parity | SCAN 10k-iteration cap was silent truncation on reset / delete-by-prefix / delete-by-filter / fetch-prefix / random / rename-namespace, while range.ts throws loudly on the identical condition | **Fixed**: all six sites now throw ValidationError, sharing `MAX_SCAN_ITERATIONS` from keys.ts. Pinned across `tests/unit/route-validation.test.ts`. Refuter widened scope (found the random + rename sites) and noted iteration count scales with total keyspace, not matching keys — making the silent case easier to hit than first stated. |
| 11 | low | parity | `/fetch` and `/delete` capped explicit-ids mode at 1000; Upstash documents the cap only for prefix fetch, none at all for delete | **Fixed**: caps lifted for explicit ids (prefix keeps its documented 1000-result bound). Pinned in `tests/unit/route-validation.test.ts`. |
| 12 | low | parity | `src/translate/keys.ts` — validatePrefix rejected glob metacharacters while ids may contain them; Upstash prefix is a literal string | **Fixed**: prefixes are accepted and `escapeGlobMeta` neutralizes metacharacters when SCAN patterns are built (namespaces remain glob-free, keeping patterns namespace-anchored). Pinned in `tests/unit/keys.test.ts` (former rejection pin updated). |
| 13 | low | concurrency | `src/redis.ts` — isRedisHealthy leaks a 2s race timer per probe | **REFUTED** (contradicted-by-code): every termination path ends in explicit `process.exit()`; timers never delay shutdown and the late resolve is a no-op. Harmless hygiene only; not changed. |
| 14 | low | concurrency | `src/redis.ts` — re-init window where getClient() throws "not initialized" | **REFUTED** (unconstructible): `reinitRedis` nulls and reassigns the client synchronously before the first await; no HTTP handler can observe the null window. |
| 15 | low | parity | `/info` reports dimension 0 on a cold server | **Open** → [#23](https://github.com/Coriou/up-vector/issues/23). Also fires after reset-all (dropIndex clears dimensionMap). |
| 16 | low | parity | Batch query capped at 100 with no documentation | **Doc fixed**: README compatibility table notes the cap (applies to /query and /query-data). Upstash documents no limit; raising/removing the cap stays open for the next parity pass. |
| 17 | moderate | resource | `src/routes/fetch.ts`/`range.ts`/`random.ts` — read paths used hgetall, transferring raw `vec` blobs and unrequested metadata/data | **Fixed**: HMGET projection gated on include* flags; EXISTS replaces the full-hash read when no fields are requested (ids mode); scan-derived keys treat existence as known. Pinned in `tests/unit/route-validation.test.ts`; the SDK compat suite caught an intermediate regression (vector-only rows reported null on metadata-only fetch), which is exactly the layer the suite exists for. |

## Refuted (5) — kept for the record

Refutation buckets: contradicted-by-code (F6-metrics, F13-timers),
scope-decision (F7-range redesign, F8-empty-filter pinned-by-test), and
unconstructible (F14-reinit window). All five are re-tested by design on
every future run, since finders are re-prompted blind.

## Verification state at close of pass

Full gate green after fixes: **465 tests** — 331 unit / 60 integration /
74 SDK compatibility — via `./scripts/test-all.sh` on Bun 1.3.14 local /
Redis Stack `7.4.0-v8`; typecheck + Biome clean; `bun audit` clean
(0 advisories, run locally at close of pass). Open findings tracked as
issues #22, #23, #24 (label `deep-audit`).
