# Maintenance: State-of-the-Art Refresh (2026-07-17)

## Goal

Bring up-vector back to a known-good, production-maintainable baseline after time away from the official Upstash Vector SDK/service surface: dependencies current where safe, full test suite green and still relevant, docs/counts/status truthful, CI health verified, and a small set of already-documented LOW hardening items closed — without expanding product scope or reopening deferred architecture work.

This is a **maintenance session**, not a feature release. Mirror the style and bar of PR #2 (`3badbbf`): fix real issues found via repro, bump safe deps, harden CI if needed, add/adjust tests, refresh docs/test counts — no architecture rewrites without a separate design.

## Non-Goals (explicit)

Settled by Decision Pack; do not implement or redesign in this pass:

| Item | Stance |
|------|--------|
| Sparse / hybrid vectors, fusion, `sparseVector` acceptance | Deferred; dense-only rejection stays |
| Resumable query cursors / sessions | Stay explicit HTTP 501 + Upstash-shaped `{error,status}` |
| Filter pushdown into RediSearch | v1 app-level over-fetch (`topK*3`, cap 1000) + JS filter remains correct-by-design |
| `/range` full-namespace load → real SCAN-cursor pagination | Known O(N)/OOM risk; deliberately deferred |
| Upstash-hosted embedding model catalog | Out of scope; OpenAI-compatible `openai`/`fake`/`disabled` only |
| In-app rate limiting | Reverse proxy only |
| Multi-token / multi-index mode | Future only |
| Live cloud parity diff vs Upstash Cloud | Local SDK + docs/SDK-source audit only |
| Major dependency jumps that require API rewrites (e.g. TypeScript 7 if it breaks `tsc`) | Out of scope unless a patch/minor is clearly non-breaking and green |

## Success Criteria

1. **Green bar:** `bun run typecheck`, `bun run lint`, unit + integration + compatibility all pass locally (and CI shape matches). Record the real test counts after the pass.
2. **SDK baseline:** Pinned `@upstash/vector` remains at npm latest (today `1.2.3`). Weekly `compat.yml` continues to install `@latest` and open issues on failure; embedding env still present so data-compat tests do not false-fail.
3. **Surface audit complete:** Dense REST + SDK methods used by `@upstash/vector@1.2.3` are either supported, explicitly 501, or rejected (sparse/hybrid fields) with no silent drift. Gaps documented in README/PLAN, not papered over.
4. **Docs truthful:** README test counts, Claude.md status, PLAN.md Phase 7 (`/upsert-data`/`/query-data` already shipped), and any memory/backlog notes agree with reality.
5. **Safe deps bumped:** At minimum the Decision Pack patch set (`hono` 4.12.27→4.12.30, `@biomejs/biome` 2.5.1→2.5.4) re-locked and fully tested. Bun CI pin remains explicit (currently `1.3.6`); only change if a pin update is needed for green installs and is verified.
6. **LOW hardening closed** (or consciously re-documented as wontfix-for-now with rationale):
   - Unauthenticated `/metrics` when enabled
   - Embedding upstream error text echoed to clients
   - Uncapped filter `IN()` value lists
   - `/random` ignores include flags
7. **No product expansion / no deferred redesigns** land in the same change set as this maintenance.

## Approaches Considered

### A — Greenbar only
Run the full suite, fix failures only, sync doc counts.  
**Pros:** Minimal risk, fastest. **Cons:** Leaves known LOW hardening and dep patches untouched; does not answer “are we still compat with the official SDK surface?” beyond existing tests.

### B — PR #2–style full maintenance (**recommended**)
Deps (safe patches) + full green + local SDK/docs surface audit + doc drift fix + CI smoke/review + implement the four documented LOW items with tests.  
**Pros:** Matches prior maintenance model; production-trustworthy without scope creep. **Cons:** Slightly larger diff; LOW items need careful compatibility checks.

### C — Aggressive modernization
Major bumps (e.g. TypeScript 7), redesign `/range` or filter pushdown, optional live cloud diff.  
**Pros:** Feels “state of the art.” **Cons:** Violates Decision Pack; high blast radius; not a maintenance pass.

**Choice: B.** Same discipline as PR #2; Decision Pack forbids C’s architecture work and live cloud work; A under-delivers on reliability and the stated “keep this software state of the art” ask.

## Design

### Workstream 1 — Baseline verification (first, always)

Order matters so later work sits on a known baseline:

1. Confirm tooling: Bun, Redis Stack available (or via `scripts/test-all.sh` / compose).
2. Install with lockfile: `bun install`.
3. Run typecheck, lint, unit, then integration + compatibility against a **fresh** Redis Stack + up-vector process.
4. Capture counts: unit / integration / compatibility / total (source of truth for doc updates).

**Test-isolation gotchas (do not “fix” incorrectly):**

- `reset` preserves namespace registry entries (intentional). The namespaces rename isolation assertion fails on dirty Redis leftover state; CI is fine because Redis is fresh per run.
- Never `FLUSHALL` under a long-lived up-vector process without restart — in-memory caches (`dimensionMap`, `knownIndexes`) go stale.
- Prefer condition polling over fixed `awaitIndexed(500ms)` sleeps if any wait is touched; do not mass-refactor sleeps unless a real flake appears (optional opportunistic improvement only).

### Workstream 2 — Official SDK / API surface audit (local only)

**Authority:** `tests/compatibility/*` driving real `@upstash/vector` against local up-vector + Redis Stack. Coverage intentionally excludes sparse/hybrid/resumable/provisioning.

**Audit method (no live Upstash Cloud):**

1. **Pinned SDK:** `node_modules/@upstash/vector` at `1.2.3` (confirm `npm view @upstash/vector version` still matches).
2. **SDK endpoint inventory:** Compare SDK `_ENDPOINTS` / `Index` methods / request shapes in published types to up-vector routes:

   | SDK / REST surface | up-vector stance |
   |--------------------|------------------|
   | Dense upsert / query / fetch / delete / update / range / reset / info | Supported |
   | `upsert-data` / `query-data` | Supported when embedding provider configured; 400 when disabled |
   | `list-namespaces` / `delete-namespace` (+ rename if REST-documented) | Supported |
   | `resumable-query*` | Explicit 501 (`src/routes/unsupported.ts`) |
   | `sparseVector`, fusion/queryMode/weightingStrategy on dense paths | Rejected via Zod `z.never().optional()` (and equivalent) |
   | Hosted model provisioning | Not implemented; not invented |

3. **Docs inventory:** Spot-check [Upstash Vector REST API](https://upstash.com/docs/vector/api/endpoints) for any **new dense** endpoint or field that dense clients might send. If found:
   - Supported path: implement only if small and testable in this pass **and** required for drop-in dense SDK use.
   - Otherwise: reject with clear validation/501 and document in README compatibility table.
4. **Compat suite relevance:** Walk `tests/compatibility/*.ts` — drop or rewrite tests that assert obsolete behavior; add a thin case only when audit finds a dense gap that existing tests miss (keep suite lean).
5. **Weekly job:** Re-read `.github/workflows/compat.yml` — embedding fake provider env, Bun pin, issue automation (labels, exact-title dedup), log capture on failure. Fix only if broken or drifted from `test.yml`.

**Out of scope for “parity” claims:** score numeric identity with cloud, ANN algorithm (HNSW vs DiskANN), filter under-topK under selective filters, `/range` memory profile.

### Workstream 3 — Safe dependency bumps

| Package | Current (lock) | Target (as of Decision Pack / npm) | Notes |
|---------|----------------|--------------------------------------|-------|
| `hono` | 4.12.27 | 4.12.30 | Patch within `^4.12.27` |
| `@biomejs/biome` | 2.5.1 | 2.5.4 | Patch within `^2.5.1` |
| `@upstash/vector` | 1.2.3 | 1.2.3 (latest) | No bump unless npm moves; re-confirm at implement time |
| `zod` | 4.4.3 | stay unless patch available and green | Avoid major/minor churn |
| `typescript` | 6.0.3 | stay | Do not jump to 7.x in this pass |
| Bun CI pin | 1.3.6 | keep unless install/runtime forces update | Dockerfile uses `oven/bun:1-alpine` (floating major tag) — optional note only; pin change is CI-focused |

Process: bump → `bun install` → re-lock → full typecheck/lint/test. Revert any bump that breaks the bar.

### Workstream 4 — LOW hardening (in-scope production hygiene)

These are documented backlog items; they are small, testable, and do not change dense-vector architecture.

#### 4.1 `/metrics` authentication posture

**Today:** `GET /metrics` is mounted **before** auth when `UPVECTOR_METRICS=true` (`src/server.ts`) for Prometheus scrape convenience. That can leak request-volume shapes if the port is public.

**Design:** Keep scrape-friendly default behavior but make exposure intentional and documented:

- **Default remains unauthenticated** when metrics are enabled (Prometheus pattern; metrics are opt-in via `UPVECTOR_METRICS=false` by default).
- Add optional `UPVECTOR_METRICS_TOKEN` (or reuse requiring Bearer when set): if set, `/metrics` requires `Authorization: Bearer <token>` (same envelope style on failure as other auth failures). If unset, current behavior.
- Document clearly in README env table: enabling metrics without a dedicated scrape network or token exposes counters; recommend network policy or the optional token.

Alternative rejected: always require `UPVECTOR_TOKEN` — breaks common Prometheus configs that cannot easily attach app Bearer tokens without extra scrape config; optional token is the compromise.

#### 4.2 Embedding upstream errors → clients

**Today:** `OpenAICompatibleEmbeddingProvider` embeds provider `error.message` (sliced to 300 chars) into `EmbeddingProviderError`, which the error handler returns to the client. That can leak upstream model names, billing hints, or internal gateway text.

**Design:**

- Log full provider detail at `warn`/`error` server-side (structured logger).
- Client-facing message: generic + HTTP class, e.g. `Embedding provider failed with HTTP 429` / `Embedding provider failed` / existing timeout message — **no** raw upstream body.
- Preserve status mapping (429/5xx → existing status choices; 504 timeout; 502 malformed).
- Unit tests: mock provider response with sensitive message; assert client JSON `error` does not contain it; optionally assert log path if easy without brittle log spies.

#### 4.3 Cap filter `IN()` lists

**Today:** Filter string length is capped (`MAX_FILTER_LENGTH = 8192`), but `IN (…)` value list length is unbounded → CPU/memory in parse/evaluate.

**Design:**

- Add `MAX_IN_LIST_VALUES` (suggest **256**, constant next to other filter limits in parser).
- On exceed: `ValidationError` with clear message (`IN list must not exceed 256 values`).
- Unit tests in `tests/unit/filter.test.ts` for over-cap and at-cap.

#### 4.4 `/random` include flags

**Today:** `src/routes/random.ts` always returns `{ id, vector }`, ignoring Upstash-style include flags for metadata/data (and optionally omitting vector).

**Design (compat-oriented):**

- Accept query/body flags consistent with other endpoints: `includeMetadata`, `includeVectors`, `includeData` (defaults: metadata/data false; **vectors true** so current “always include vector” callers keep working — match fetch/query patterns carefully).
  - Prefer aligning with Upstash REST if docs specify defaults; if ambiguous, default `includeVectors: true` to preserve current response shape for clients that only read `result.vector`.
- GET: read boolean query params; POST: optional JSON body with same fields (invalid JSON on POST with empty body → treat as defaults).
- Omit fields when flags are false; still return `id` and `null` when empty namespace.
- Integration or unit-level route test covering flag combinations.

If Upstash REST documents no include flags for random, still accept and honor them for consistency with fetch/range and zero harm to SDK (SDK may not expose random).

### Workstream 5 — Documentation & status truth

Update in one pass after final test counts:

| File | Fix |
|------|-----|
| `README.md` | Replace stale **346** with actual totals; keep “74 compatibility” only if still true |
| `Claude.md` | Confirm **360** (or new total) and phase/status blurb; env table if new `UPVECTOR_METRICS_TOKEN` |
| `PLAN.md` Phase 7 | Mark `/upsert-data` + `/query-data` **done** (provider-backed, not “local model” fantasy); leave sparse/hybrid/resumable/multi-token/filter-v2 deferred |
| `docs/architecture/sparse-hybrid.md` | Leave roadmap; no content change required unless a one-line “still deferred as of 2026-07-17” helps |
| Project memory / backlog | After implement: mark LOW items done; restate deferred architecture items |

Also ensure README compatibility table still states dense-only scope and 501 resumable.

### Workstream 6 — CI health

Review only; change when broken or inconsistent:

- `.github/workflows/test.yml` — Bun `1.3.6`, embedding fake env on integration job, health wait, log dump on failure.
- `.github/workflows/compat.yml` — same embedding env as test.yml, `@upstash/vector@latest`, issue labels/dedup.
- `scripts/test-all.sh` — free port discovery, fake embedding env, full local gate.

No new workflows required for this pass.

### Workstream 7 — Bugs found during audit

If the suite or audit surfaces a **real** production bug (wrong score mapping, envelope mismatch, crash, data corruption):

- Fix with live repro against Redis Stack (PR #2 style).
- Add regression test.
- Do **not** fold in unrelated refactors.

If the issue is a deferred architecture item (`/range` memory, selective filter under-topK), document only — do not redesign.

## Implementation Order

```text
1. Baseline green (or catalog failures)
2. Safe dep bumps → re-green
3. SDK/API surface audit (read-only) → ticket any must-fix dense gaps into this pass
4. LOW hardening 4.2, 4.3, 4.4, 4.1 (tests with each)
5. Compat/unit/integration adjustments as needed
6. Docs + PLAN Phase 7 + env tables
7. Final full suite + record counts in commit/PR description
```

Suggested PR title style (mirror #2):

> Maintenance: deps, SDK surface audit, LOW hardening, doc truth

## Testing Plan

| Layer | What |
|-------|------|
| Unit | Filter `IN` cap; embedding client-facing error sanitization; scores/vectors untouched unless bugfix |
| Integration | `/random` include flags; metrics optional auth if implemented; auth still 401 without token on business routes |
| Compatibility | Full `tests/compatibility` with pinned SDK; manual note that weekly job covers `@latest` |
| Local gate | `scripts/test-all.sh` or equivalent CI-parity sequence |
| Negative | Sparse field still rejected; resumable still 501; dirty-Redis rename test not “fixed” with FLUSHALL hacks |

## Risk & Rollback

| Risk | Mitigation |
|------|------------|
| Dep bump breaks Biome/Hono types | Revert single package; patch-only policy |
| Metrics token surprises operators | Opt-in env; default behavior unchanged when unset; docs |
| `/random` default change breaks clients | Keep default vector inclusion; only omit when flag false |
| Over-scoping into range/filter redesign | Checklist non-goals; reviewer rejects architecture diffs |
| Test isolation false failures | Fresh Redis; restart after flush; document in PR |

Rollback: single PR revert; no migration/data format changes expected. Filter cap and error sanitization are request-path only. Optional metrics token is config-only.

## Deliverables Checklist

- [ ] Full test green; counts recorded
- [ ] `hono` / biome patch bumps (or documented skip if already current)
- [ ] `@upstash/vector` confirmed latest pin
- [ ] Surface audit notes (in PR body): no unexpected dense gaps, or gaps fixed/rejected/documented
- [ ] LOW items 4.1–4.4 implemented + tests
- [ ] README / Claude.md / PLAN.md Phase 7 synced
- [ ] CI workflows reviewed; fixed only if needed
- [ ] PR description lists deferred items still out of scope (`/range`, filter pushdown, sparse/hybrid, resumable, multi-token)

## Relationship to Deferred Work

After this pass, the intentional backlog remains:

1. `/range` real cursor pagination (O(N) memory today)
2. Metadata filter pushdown (selective filters can return &lt; topK)
3. Sparse / hybrid (see `docs/architecture/sparse-hybrid.md`)
4. Resumable queries
5. Multi-token mode

Those need their own design specs — not this maintenance session.
