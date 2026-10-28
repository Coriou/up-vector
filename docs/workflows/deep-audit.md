# Deep Audit — Deterministic Workflowz

Re-runnable adversarial audit for up-vector. This document is the executable
procedure: an agent harness (or a future CI agent runner) executes it verbatim
and produces an identical-shape result. Past runs: `docs/audits/`.

Cadence (per `docs/RUNBOOK.md`): quarterly, before notable releases, and after
any upstream major (SDK, Bun, Redis Stack).

## Preconditions (all must hold before Phase 1)

1. Working tree clean, on a branch cut from `main` (`maintenance/deep-audit-YYYY-MM-DD`).
2. Baseline gate green on the base commit: `./scripts/test-all.sh`. Record test
   counts and Bun/Redis versions — they go in the run artifact.
3. Pins recorded: `bun --version`, Redis Stack tag from `docker-compose.yml`,
   `@upstash/vector` version from `bun.lock`.

## Phase 1 — Finders (parallel, mutually blind)

Spawn 5 read-only agents in one fan-out. No finder sees another's output.
Each returns ONLY a JSON array (may be empty):

```json
[{"dimension": "...", "file": "src/...", "line": 123, "title": "...",
  "evidence": "concrete code path or input that triggers the behavior",
  "severity": "low|moderate|high", "suggested_disposition": "fix|triage"}]
```

No vibes: every finding cites `file:line` and names the exact input or code
path. A finding without a constructible trigger is not a finding.

### Finder 1 — protocol correctness

Read: `src/translate/vectors.ts`, `src/translate/scores.ts`,
`src/translate/index.ts`, `src/translate/keys.ts`, `src/redis.ts`, and the
unit tests that pin them (`tests/unit/`). Hunt:

- Float32 little-endian round-trip correctness (encode/decode symmetry,
  denormals, -0, max magnitude).
- RESP2 vs RESP3 shape handling for `FT.INFO` / `FT.*` replies.
- Score normalization per metric (COSINE / EUCLIDEAN / DOT_PRODUCT): bounds,
  inverted-distance handling, 0-1 contract with the Upstash SDK.
- Binary-safety: every Redis path touching vector bytes must use
  `redis.send(...)`; flag any `hset`/`hgetall` on binary fields.

### Finder 2 — security

Read: `src/middleware/auth.ts`, `src/middleware/error-handler.ts`,
`src/config.ts`, `src/server.ts`, `src/translate/keys.ts`,
`src/filter/parser.ts`, `src/filter/evaluator.ts`, all `src/routes/*`. Hunt:

- Auth bypass vectors (header parsing, missing middleware on new routes,
  metrics token path).
- Injection through ids / namespaces / filter strings / prefix into Redis
  commands and key names (key building must be injection-proof).
- Error envelope leaking internals (stack traces, Redis error text) to clients.
- Body-limit enforcement actually applied to every route; header handling
  edge cases.

### Finder 3 — resource safety

Read: `src/middleware/timeout.ts`, `src/routes/query.ts`, `src/routes/range.ts`,
`src/routes/fetch.ts`, `src/routes/upsert.ts`, `src/config.ts`,
`src/shutdown.ts`, `src/index.ts`. Hunt:

- topK / dimension / vector-count bombs (no upper bound where one is cheap).
- Unbounded over-fetch in metadata filter evaluation (v1 app-level filtering:
  bounded by design? verify the bound).
- Timeout coverage gaps (routes or phases outside the middleware).
- Shutdown drain correctness: in-flight writes during `SIGTERM`, index-create
  races at shutdown.

### Finder 4 — Upstash parity

Read: the installed SDK at `node_modules/@upstash/vector/dist/` (grep
`_ENDPOINTS` / `fetch` paths for the endpoint inventory), every
`src/routes/*`, `README.md` parity table, and the live REST docs at
`https://upstash.com/docs/vector/api/endpoints` (fetch each endpoint page).
Hunt:

- Every SDK endpoint must be: supported, explicitly rejected (validation
  error), or explicitly 501 (`src/routes/unsupported.ts`). Flag anything
  silently missing or silently wrong-shaped.
- Request/response field parity: option names, defaults, error envelope
  shapes, `X-Upstash-*` header expectations.
- Documented Upstash limits (e.g. caps, payload bounds) that we enforce
  differently — each difference must be a documented deviation or a finding.

### Finder 5 — concurrency & self-heal

Read: `src/redis.ts`, `src/translate/index.ts`, `src/routes/reset.ts`,
`src/routes/upsert.ts`, `src/shutdown.ts`, `src/health.ts` (or equivalent),
`src/metrics.ts`. Hunt:

- Redis client re-init (`UPVECTOR_REDIS_REINIT_AFTER_MS`): in-flight command
  behavior during re-init, timer leaks, double re-init.
- Lazy `FT.CREATE` races: two concurrent first-upserts, create-after-drop,
  create during shutdown.
- Reset atomicity: index drop vs key deletion interleaving with concurrent
  upserts (known open race — re-verify, look for cheaper fixes).
- Health probe correctness during Redis unavailability; metrics counters
  under error paths.

### Scope guardrails (decisions, not bugs — finders must not report)

- Sparse/hybrid vectors are intentionally rejected.
- Resumable query endpoints are intentionally 501.
- Metadata filtering is intentionally app-level over-fetch in v1.
- Score values approximate Upstash cloud semantics; not bit-identical.
- `UPVECTOR_DIMENSION` fixed-at-boot is intentional.

## Phase 2 — Refutation (parallel, after Phase 1 settles)

One skeptic agent per finding, prompted to REFUTE. Default is "refuted" when
evidence is weak. A finding survives ONLY if the skeptic:

1. Re-reads the cited code and confirms the trigger is constructible against
   the real request flow (not a hypothetical caller), AND
2. Finds no test or committed scope decision that pins the behavior as
   intentional, AND
3. For parity claims: confirms the discrepancy against the installed SDK
   source and the live docs, not memory.

Output per finding: `SURVIVES` with corrected file:line + tightened evidence,
or `REFUTED` with the reason (contradicted-by-code | pinned-by-test |
scope-decision | unconstructible). Disputed findings are recorded as
disputed — never silently dropped, never silently kept.

## Phase 3 — Synthesis (orchestrator, not delegated)

1. Personally re-verify every survivor against current code (read the cited
   lines; run the triggering input where cheap). Orchestrator verification is
   mandatory — subagent output is evidence, not truth.
2. Deduplicate overlapping findings; severity-rank (high > moderate > low).
3. Disposition per survivor:
   - **fix** and the fix is small, test-coverable, and behavior-compatible →
     land in this pass with a regression test (fails pre-fix, passes post-fix).
   - **open** → GitHub issue labeled `deep-audit` (+ `security` if security
     dimension), with evidence and candidate mitigations. Never leave an open
     finding tracked only in prose.
   - **disputed** → keep on record in the run artifact with both arguments.
4. Write `docs/audits/YYYY-MM-DD-deep-audit.md` following the shape of
   `docs/audits/2026-08-22-deep-audit.md`: raw counts, survivor table
   (severity / dimension / finding / disposition), refuted list summary,
   verification state at close.
5. Doc truth: update test counts / pins in `docs/RUNBOOK.md` baseline and
   `CLAUDE.md` if they changed.

## Exit criteria

- [ ] Full gate green after remediation: `./scripts/test-all.sh` (record counts).
- [ ] `bun audit --json` clean, or advisories dispositioned in issues.
- [ ] Every survivor: fixed-with-test, or issue filed, or recorded disputed.
- [ ] Run artifact committed; RUNBOOK/CLAUDE.md doc truth holds.
- [ ] Branch → PR → merge to main; main never left red.
