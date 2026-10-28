# Astra adversarial review and remediation — 2026-10-28

Base: clean main `5be3db95d0b85dcc490cce5ee75ffdbfe6f3988f` (merged PR47).
Reviewed the previous maintenance diff, CLAUDE.md, RUNBOOK.md, packaged deep-audit
procedure, and the earlier same-day maintenance report. This is a direct Astra
finder/refuter pass with executable counterexamples, **not** the packaged five
mutually blind finders and independent skeptic-per-finding workflow. No agents
were delegated. No secrets, cloud embedding service, publication, tag, or merge
were used. The parent owns review, merge, release decisions, and worktree cleanup.

## Baseline and validation

The pristine base passed `./scripts/test-all.sh` before remediation: **475 tests**
(340 unit / 61 integration / 74 installed-SDK tests), typecheck, lint, and build.
The worktree initially lacked dependencies; `bun install --frozen-lockfile`
installed them without changing the lockfile. All executions below used Bun
**1.4.4**, via `/tmp/up-vector-bun-canary/node_modules/.bin` on PATH; the host's
default Bun is 1.4.0 and was not used for this gate.

Final gate: **489 passed, 0 failed** (347 unit / 68 integration / 74 SDK),
typecheck, Biome without warnings, and production bundle. Redis Stack remains
`7.4.0-v8` (Redis 7.4.7), SDK `@upstash/vector` 1.2.3. `bun audit --json` returned
`{}`. Final Docker build and private-network smoke passed on Bun 1.4.4: health,
401 without auth, upsert, and indexed query ID/metadata/vector/score checks.
The SDK suite uses fake server embeddings, not an external model-quality test.

Logs on the audit host (not repository artifacts):

- `/tmp/up-vector-astra-baseline.log`: untouched-base full gate.
- `/tmp/up-vector-astra-prefixed.log`: three failing Redis regressions before fixes.
- `/tmp/up-vector-astra-budget-before.log`: accepted oversized query before budget.
- `/tmp/up-vector-astra-zombie-before.log`: late deletion with dispatch guard disabled.
- `/tmp/up-vector-astra-open-risks.log`: controlled reset/rename interleavings.
- `/tmp/up-vector-astra-final-gate.log`: final gate.
- `/tmp/up-vector-astra-docker-build.log`, `/tmp/up-vector-astra-docker-smoke.log`.

## Findings and refutation

Eleven grouped candidates: **seven survived**, of which five are fixed or
mitigated with regression tests and two remain in existing issues; four were
rejected. Existing issue claims were not accepted as proof.

| Severity | Candidate | Concrete challenge/result | Disposition |
| --- | --- | --- | --- |
| High | #13 late destructive continuation | Real Redis `CLIENT PAUSE 150 ALL`, 20ms handler deadline, delete-namespace returns 504. With guard disabled, waiting for the actual late handler proves the vector is deleted. | Request-scoped deadline/expired state guards every Redis method invocation, including pre-acquired handles. Later SCAN/DEL/SREM are stopped. Already-issued commands cannot be cancelled or rolled back; retain that caveat. |
| High | #14 response amplification | Legal 16,384-dimensional query, topK 1000, includeVectors reached FT.SEARCH before the fix. Worst-case vector JSON alone exceeds 390 MiB; batches multiply it. A command-capture regression avoids intentionally OOMing the host. | 64 MiB conservative per-request projection reservation before query/fetch/range bulk reads, shared across query/query-data batches and active even with timeout disabled. Oversize returns 400, never truncated success. This is not an RSS/concurrency guarantee. |
| Moderate | #15 slow health causes destructive reinit | `CLIENT PAUSE 2300 ALL` makes the 2s health probe fail while the client remains connected. Before the fix, reinit replaced it; after, the original pending PING returns PONG. | Reinit only disconnected clients; single-flight health probes, cleared timers, fresh health state per connection, and no watchdog recovery during shutdown. |
| Moderate | Stale index cache after Redis replacement/reconnect | Create index dim 3, remove it, replace client: old cached dimension survives and new index creation is skipped/rejected. Also kill the client connection after removing the index to exercise automatic reconnect. | Connection generation invalidates dimensions, known indexes, and pending creation map. Old in-flight completions cannot populate a new generation's cache. Both real Redis cases recreate dim 4. |
| Moderate | Lua PATCH corrupts unrelated JSON | Upsert `untouched: []`, `precise: 9007199254740991`, `items: [1]`; patch `items: []`. Before: arrays become `{}`, precision becomes `9007199254741000`. | RFC 7396 merge in JS; exact-snapshot compare plus all-field HSET in one Lua step. Eight bounded retries, then 409. Existing oversized-merge/unchanged-vector/data test remains green; disjoint concurrent PATCH writers preserve all fields. A forced competing write on every CAS attempt proves 409 after eight attempts without partial vector/data writes. |
| Moderate | Reset/upsert race | Park an actual upsert immediately before its EVAL (after ensureIndex); let reset complete; release the write. Both requests return 200, the vector exists but `FT._LIST` lacks its index. | Still open: [#24](https://github.com/Coriou/up-vector/issues/24). Needs writer/destructive-operation coordination, including multiple proxy processes. A process-local mutex would overstate protection. |
| Moderate | Rename/upsert race | Same parked upsert, then rename source to target, then release. Both requests return 200; source has a new raw vector without its source index while seed data moved to target. | Still open: [#16](https://github.com/Coriou/up-vector/issues/16). Not fixed by timeout guards or cache invalidation. |

The reset/rename probe used actual Hono routes and Redis; only the dispatch of
one EVAL was gated with promises to make the interleaving deterministic. Its
temporary test was removed after recording both outcomes. It is not counted
among the committed regression tests. The timeout regression explicitly waits
for late-handler completion: an initial PING-only observation could inspect
state before late SCAN/DEL completed and was rejected as insufficient evidence.
The corrected test fails with the guard disabled and passes with it enabled.

Rejected candidates:

1. **Projection drops filter metadata:** contradicted by command capture and
   current code; filters request metadata even with includeMetadata false,
   while returned fields still obey flags. Real SDK fetch/range/query include
   flags remain covered. Random fetches all three stored fields for one row;
   that bounded inefficiency is not the multi-result amplification defect.
2. **The previous merged-PATCH size guard writes vector/data before rejection:**
   refuted by the unchanged-fields real integration regression on the base.
   The new compare-and-write path preserves this property; it replaces cjson
   for JSON fidelity, not because the old cap was ineffective.
3. **The atomic update path corrupts binary vectors:** refuted by base and final
   real tests querying the updated RediSearch vector, not merely reading its
   base64 mirror. EVAL still uses `send()` and raw Buffer arguments.
4. **Auth/glob namespace escape through the changed routes:** no constructible
   bypass survived current validation and executable auth/key/prefix/error
   tests. Health/metrics pre-auth placement is deliberate; bearer challenges
   and generic internal-error envelopes remain covered. This is scoped review
   evidence, not a proof that all possible bypasses are absent.

Sparse/hybrid rejection, resumable 501, bounded app-level metadata filtering,
score approximation, and boot-fixed dimensions remain declared guardrails.
For PATCH parity, inspected the installed SDK's metadataUpdateMode type and
[Upstash's current update contract](https://upstash.com/docs/vector/api/endpoints/update),
which specifies [RFC 7396](https://www.rfc-editor.org/rfc/rfc7396).

## Limits and release handoff

The new read cap is an explicit compatibility deviation. It estimates maximum
legal field sizes rather than reading payloads to discover their sizes (which
would defeat the memory defense). Fetch/range use the maximum vector dimension;
filter candidates also consume budget. Clients may need smaller batches/pages,
particularly with includeData. It is a serialized-projection budget, not a hard
heap cap or ingress rate limit. External raw Redis writes exceeding the API's
field limits are outside this bound.

Remaining operational risks: #3 full-keyspace range memory, #17 concurrent large
upserts, #22 body buffering before the application deadline, #23 cold info
without a configured dimension, #16/#24 namespace races, and manual FLUSHALL or
index deletion without reconnect (restart the process). #4 filter underfill is
intentional v1 behavior. #13 is mitigated between commands, not transactionally
rolled back. Do not advertise this pass as eliminating all concurrency/resource
risks or automatically mark every issue closed.

Publication investigation via `gh`, Git history, README, and workflows:

- README names **`ghcr.io/coriou/up-vector:latest`**; Compose builds locally.
- Only test/compatibility/maintenance workflows exist; no publish workflow is
  present in the repository history inspected.
- Remote tags and GitHub releases are empty. Package version is **0.1.0**.
  There is **no established version/tag convention**; do not invent one and
  describe it as historical practice.
- Package listing returned GitHub **403: missing read:packages scope**. GHCR
  manifest inspection timed out reaching `/v2/`. Neither proves image absence;
  image existence, registry write authorization and release policy are unverified.
- Main's Test workflow passed at the base SHA. Latest weekly compatibility and
  maintenance runs passed on **2026-10-26**, but against pre-PR47 `3162ccc`, not
  this change. Parent should refresh them on the final merged revision before
  publishing if following the runbook release gate.

Release is **not unconditionally cleared**: hosted PR checks/review and the
publication prerequisites remain, plus explicit acceptance/remediation of the
open operational risks. No tag, release, registry push, or merge was performed.
All local gate/smoke containers, networks, and test volumes were removed by their
scripts. The active managed worktree and unrelated branches/resources remain.

## Independent final review of PR48

A new direct review inspected `ad444ee04ba78d2cbfef6cb06ee311a992c04166`
against `5be3db9`, without delegated agents. One additional concrete regression
survived refutation: `ensureIndex` waiters could accept a different dimension
when an in-flight creator crossed a connection generation change. The old cache
write was correctly discarded, but the waiter treated the missing cache as
successful validation. A deterministic regression returned `accepted` before
this fix. Waiters now re-enter index validation; creators also revalidate when
their generation changed. The old-completion test now requires rejection of an
incompatible current-generation dimension as well as preservation of its cache.

Other challenged paths:

- ALS guards act at invocation, including detached/pre-acquired handles, and
  native method calls use the underlying Bun client as receiver. Real Redis
  suites exercise `send`, native helpers, timeout continuation, and reconnect.
- The `read-budget -> routes/upsert -> redis` import path does not lead back to
  read-budget: Redis imports only request-context and the separate generation
  module. Standalone budget tests, server startup, and the production bundle
  pass. Projection reservation covers filter metadata and shared batch context;
  conservative rejection and externally oversized Redis fields remain limits.
- PATCH retains Buffer arguments through `send("EVAL", ...)`; comparison and
  all-field writes are atomic. Real RediSearch query tests, precision/array
  preservation, disjoint concurrent PATCH tests, and forced eight-retry conflict
  tests pass. It is not a transaction across reset/rename or all requests.
- Health single-flight and connected-client non-replacement, generation cache
  invalidation, and real automatic reconnect pass their Redis regressions.

Added manual `publish.yml` and a tested `verify-publication-gates.sh`: main-only,
exact checkout SHA, serialized publication, least-privilege GITHUB_TOKEN,
latest successful same-SHA Test/SDK Compatibility/Maintenance gates, local
linux/amd64 build and exact-image smoke before login, full-SHA/latest tags,
source/revision labels, and registry digest in the summary. Gates run again
before push; no polling or publication occurs during this review. Test now also
supports manual dispatch for commits otherwise excluded by path filters.
README/RUNBOOK document dispatch, package visibility/access, platform scope,
mutable tags, partial-push behavior, and final-main-SHA requirements. The earlier
publication-infrastructure investigation above describes the pre-review state.

Final validation on Bun **1.4.4**: **495 passed, 0 failed** (353 unit, 68
integration, 74 installed SDK 1.2.3 compatibility), typecheck, lint, production
build, clean `bun audit --json` (`{}`), Actionlint across all workflows,
ShellCheck/bash syntax for the publication gate, linux/amd64 Docker build and
production smoke. Five publication tests cover success, each missing gate,
pending/failed/skipped/cancelled latest runs despite older green runs,
SHA/branch/repository/event mismatch, non-main/non-manual dispatch, and main
advancement. The workflow-run API response shape was also checked read-only
against the existing successful main Test run. No registry write was attempted.

Host evidence: `/tmp/up-vector-final-review-gate.log`,
`/tmp/up-vector-final-review-docker.log`, `/tmp/up-vector-final-review-smoke.log`.

Verdict: no remaining newly introduced blocker found after the reconnect fix.
This does not close existing reset/rename races or the resource/timeout limits
listed above. Hosted checks and approval apply to the new PR head; the parent
must merge only after those gates, then dispatch all release gates for the final
main SHA and publish only once they pass. This reviewer does not merge, publish,
watch the PR, or remove the parent's managed worktree.
