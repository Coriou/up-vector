# Deep Audit — 2026-08-22

First run of the deep-audit workflowz described in `docs/RUNBOOK.md`. Method:
5 mutually-blind finder agents (SDK parity, Upstash REST docs parity, protocol
correctness, security, resource/concurrency) produced **15 raw findings**; each
was attacked by a skeptic verifier prompted to refute (default-refute). **6
survived** with concrete evidence; 9 were refuted.

## Confirmed findings and dispositions

| # | Severity | Dimension | Finding | Disposition |
|---|---|---|---|---|
| 1 | moderate | resource | `src/middleware/timeout.ts` — a request that times out leaves its handler chain unobserved; a late rejection became an `unhandledRejection` at process level | **Fixed** in the same pass: loser chain now observed + logged (`late failure after request timeout`). Regression test in `tests/unit/timeout.test.ts`. |
| 2 | moderate | protocol | `src/translate/index.ts` — existing-index validation compared only dimension; restarting with a different `UPVECTOR_METRIC` against existing data silently mis-normalized scores | **Fixed**: FT.INFO metric parsed (`parseMetricFromInfo`, RESP3 + RESP2 shapes) and `validateIndexCompatibility` fails loudly on metric or dimension mismatch. Tests in `tests/unit/index-info.test.ts`. |
| 3 | low | security | `src/routes/metrics.ts` — optional metrics token compared with plain string equality while main auth is timing-safe | **Fixed** for consistency: `timingSafeEqual` with length pre-check (same tradeoff as hono's bearerAuth). Existing `tests/unit/metrics-auth.test.ts` stays green. |
| 4 | moderate | protocol | Float32 overflow silent: f64 inputs like `1e300` pass Zod finiteness but become `±Infinity` in the stored/indexed vector (`src/translate/vectors.ts`) | **Open triage** — decide: reject non-float32-representable values at validation, or clamp+warn. Behavior change → needs compat-suite review before landing. |
| 5 | low | parity-docs | `/fetch` caps `ids` at 1000 (`src/routes/fetch.ts`); Upstash documents the cap only for prefix-mode fetch | **Open triage** — either lift the cap for explicit-id fetches or document the deviation in README parity table. |
| 6 | low | resource | Single-namespace reset (`src/routes/reset.ts`) runs dropIndex then key deletion non-atomically; an upsert racing between the steps can be wiped by the subsequent delete | **Open triage** — known distributed-race class; candidate fix: tombstone/version check or per-namespace reset mutex. Assess real-world likelihood before adding complexity. |

## Refuted (9) — kept for the record

Refutations fell into three buckets: claims contradicted by the actual code
(most common), behavior pinned deliberately by tests or scope decisions
(sparse-reject, resumable-501, app-level filtering), and exploit paths the
verifier could not construct against the real request flow. None are tracked
further; finders were re-prompted blind, so repeat runs re-test them.

## Verification state at close of pass

Full gate green after fixes: **383 tests** — 249 unit / 60 integration / 74 SDK
compatibility — via `./scripts/test-all.sh` on Bun 1.3.14 local / Redis Stack
`7.4.0-v8`; typecheck + Biome clean; `bun audit` clean on hono 4.13.3.
