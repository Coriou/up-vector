# Maintenance verification — 2026-10-28

Scope: refresh from `origin/main` `3162ccc`, reconcile unmerged PR #25 at
`42f3c0f`, security issues #44/#38/#30, dependency drift, dense SDK contract,
runtime/database canaries, and the production Docker artifact. No cloud API key
was used. No existing PR or issue was merged or closed by this pass.

## Method and limits

Read CLAUDE.md, RUNBOOK.md, the prior audit and packaged audit procedure. Three
read-only agents covered protocol/parity, security/resource safety, and
concurrency/self-heal; protocol and security findings were cross-refuted before
fixes, followed by focused code review and executable probes. Additional passes
covered injection/auth/body/header safety and binary/score/RESP correctness.
This is a maintenance audit with grouped dimensions, **not** a claim to have
executed the packaged five-mutually-blind-finder/one-skeptic-per-finding deep-audit
procedure verbatim. The first full local gate was run after reconciliation,
not as an untouched-main baseline. Historical September results remain a dated
record; current results below supersede their dependency/test claims.

## Versions and verification

Registry queried directly with `npm view` on 2026-10-28:

| Component | Main / previous | Verified result |
| --- | --- | --- |
| Hono | 4.13.3 | **4.13.14**, latest |
| Zod | 4.4.3 | **4.6.7**, latest |
| Biome | 2.5.10 | **2.6.3**, latest |
| @types/bun | 1.4.0 | **1.4.4**, latest |
| @upstash/vector | 1.2.3 | **1.2.3**, latest unchanged |
| TypeScript | 6.0.3 | **6.0.3**, newest 6.x; latest 7.0.2 intentionally held |
| Bun | CI 1.4.0; Docker floating 1.4-alpine | full gate on **1.4.0 and 1.4.4**; CI + Docker now exact **1.4.4** |
| Redis Stack | 7.4.0-v8 | unchanged; `latest` resolves to the same image, Redis **7.4.7** |
| Docker engine | — | **29.8.2** |

Redis Stack baseline and latest both resolved to
`sha256:798ab84d9f266936b034ab11c4d04a2b8e4b441884c5aa7d17ac951eefdf742a`.
The Bun Docker 1.4.4-alpine manifest resolved to
`sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a`.
Bun pins moved only after the complete 1.4.4 canary passed. Redis pin was held:
there is no new artifact to promote. Tags are version-pinned, not immutable
digest-pinned; weekly canaries and Dependabot continue to detect drift.

Local gate results: **475 passing tests**, **0 failures**:

- **340 unit** — including index rejection retry/cache safety, L2/IP alias
  discovery/startup, finite metric labels, reset-all error propagation, and
  prefix-fetch deletion race coverage.
- **61 real Redis integration** — including oversized merged PATCH rejection
  with unchanged vector, data, and metadata, followed by a successful shrinking
  merge patch.
- **74 SDK compatibility** — real installed `@upstash/vector` 1.2.3, fake server
  embedding provider (not a cloud embedding-model quality test).
- Typecheck, Biome lint (no warnings), production bundle, frozen lockfile
  install, shell syntax, Actionlint, and `git diff --check` passed.
- `bun audit --json` returned **`{}`**, zero current advisory findings.
- Docker build and `scripts/docker-smoke.sh` passed against the final non-root
  image, Bun 1.4.4, and Redis `latest`: readiness, unauthenticated 401, upsert
  Success, indexed result ID, metadata, vector dimension, and self-match score.
  Query readiness is polled; a 200 with an empty/wrong result fails the smoke.

The final 1.4.4 gate covers all source fixes. A full 1.4.0 gate also passed
before the final challenge-header correction; that correction was separately
covered by the final unit/full gate under the promoted 1.4.4 runtime. Hosted CI
and human review are separate pending release gates when this PR is opened.

## Security signals #44, #38, #30

#44 contains six advisories; #38 and #30 are earlier overlapping subsets.

| Advisory | Exposure assessment | Resolution |
| --- | --- | --- |
| GHSA-gqvv-2mrq-wpjv | `toSSG` is not imported/used | Hono >=4.13.5; now 4.13.14 |
| GHSA-g6gw-c38x-mqfc | `parseBody` dot notation is not used (JSON bodies) | Hono >=4.13.5; now 4.13.14 |
| GHSA-crvj-82cr-hjcx | Query parsing is used for reset-all; no response cache, global no-store; no demonstrated cache bypass here | Hono >=4.13.5; now 4.13.14 |
| GHSA-hxh3-vqpv-xpqv | JSX/boundary rendering is not used | Hono >=4.13.7; now 4.13.14 |
| GHSA-5r4p-p66f-jhc7 | `serveStatic` is not mounted | Hono >=4.13.11; now 4.13.14 |
| GHSA-mrhx-c7xc-m3w5 | Relevant: Zod validates attacker-controlled constrained collections | Zod >=4.6.6; now 4.6.7 |

These conclusions are scoped to this lockfile and date; a clean advisory DB
result is not a claim of absence of application vulnerabilities.

## PR25 reconciliation

Reviewed the source/test diff rather than merging its branch. Preserved its
historical audit and reusable procedure, and incorporated:

1. Conditional FT.SEARCH RETURN projection (score always included).
2. Ignore foreign indexes when synchronizing a shared Redis DB.
3. Incoming metadata/data limits across update and embedding upsert.
4. Loud shared SCAN cap failures instead of truncated success.
5. Float32 provider-output bounds before encoding.
6. Prefix glob escaping, so legal literal metacharacters work safely.
7. HMGET read projection for fetch/range/random rather than raw vector HGETALL.

**Deliberately rejected:** removal of the 1000 explicit-ID fetch/delete cap.
The current implementation uses eager Promise.all for fetches and one large
DEL for deletes. An HTTP body cap does not bound the number of in-flight Redis
operations to a safe value. Retain the existing 1000 limit and document this
intentional parity deviation; callers can split batches. PR25's tests that
expected 1001-ID success were replaced with early-rejection assertions.

**Amended:** PR25's scan error was still swallowed by reset-all; now any failed
index drop or key deletion is propagated after all targets were attempted, and
the embedding-mode registry is not cleared on partial failure. Partial erasure
is still possible and is not rolled back. Its prefix-fetch projection also
assumed SCAN keys still existed; the final implementation checks existence when
all projected fields are absent, omitting rows deleted after SCAN.

## Additional findings and fixes

| Finding | Refutation/evidence | Disposition |
| --- | --- | --- |
| L2/IP indexes rejected after restart under EUCLIDEAN/DOT_PRODUCT | Redis-native metric names were compared directly to app enum strings; create path already normalized them | Normalize load/sync comparisons and validate configured dimension |
| Failed index verification poisons trusted caches | First mismatch throws; second lookup previously returned cached dimension and bypassed validation | Cache only after successful validation; repeated-rejection regression tests |
| Metadata PATCH grows persisted objects past per-write cap | Two individually legal disjoint 90KB fields exceed 128KiB after merging; Lua writes were performed before any final-size check | Check merged UTF-8 byte length inside Lua before **any** HSET; controlled 400 and atomic unchanged fields |
| Metrics retain arbitrary unauthenticated paths | Three arbitrary lowercase paths created separate counters/histograms when metrics enabled | Finite route and method vocabularies; unknown paths collapse to one label |
| Bearer challenge lost by JSON error envelope | Hono HTTPException carried WWW-Authenticate but c.json discarded it | Preserve challenge header, JSON envelope unchanged; regression assertions |

No further concrete binary/score/RESP, auth-bypass, or injection defects were
established by the additional finder passes. That is review evidence, not a
formal proof.

## Maintenance automation changes grounded in observed behavior

- Biome 2.6 adds Markdown formatting and a new string-placeholder warning. Its
  unmodified bump reformatted historical documents; exclude Markdown from the
  code formatter, update schema, and clarify the literal test character set.
  Existing PR46's hosted lint failure was inspected; current lint is green.
- Local test script previously used the deployment Compose project/volume,
  slept fixed durations, and removed the default stack. It now uses a unique
  disposable project/volume, registers cleanup before startup, probes readiness,
  and includes the production bundle in the gate. Test Redis URL/token/provider
  are intentionally supplied by the script rather than inherited deployment
  settings. It removes only its own resources.
- Docker smoke previously checked curl status only, accepting an empty query
  response. The shared script asserts the stored result and is used both weekly
  and in PR CI. It avoids a floating auxiliary curl image and uses no host ports.
- PR CI paths now include scripts so smoke-script-only changes are checked.

## Outstanding issues and handoff

No existing issue/PR was closed. After hosted checks and review, this PR
supersedes **PR25** (with the explicit cap decision above), **PR41** (Hono
4.13.13), **PR43** (Zod 4.6.7), **PR45** (Bun types 1.4.4), and **PR46**
(Biome 2.6.2). Security issues **#44/#38/#30** can be resolved against the
updated lockfile. **#6** is stale: optional metrics token/docs, generic provider
errors, IN-list cap 256, and random include flags are already implemented.
Parent should reconcile those only after the replacement PR's release gates.

Residuals, deliberately not presented as solved:

| Issue | Remaining risk |
| --- | --- |
| #3 | Range still loads/sorts all matching keys; SCAN iteration cap bounds work, not aggregate memory tightly |
| #4 | App-level post-filtering over-fetches only 3x/up to 1000 and can return fewer than topK |
| #5 | Fixed indexing waits/test namespaces; index caches also remain stale after manual FLUSHALL or replacement Redis without persisted indexes, including self-heal |
| #13 | Timeout returns 504 while destructive work continues; no cancellation/rollback |
| #14 | Requested metadata/data/vector responses and query batches can still amplify memory substantially; projection fixes only unrequested transfer |
| #15 | A slow but connected Redis can trip the 2s health probe and destructive client reinitialization |
| #16 | Namespace rename remains a multi-command operation racing concurrent writes |
| #17 | Max-legal upsert batches/concurrent requests still amplify memory |
| #22 | Chunked body buffering precedes application timeout; use an upstream request-body deadline/connection limits |
| #23 | Cold `/info` dimension can be 0 unless configured |
| #24 | Reset drop-index/delete sequence still races concurrent upserts |

Sparse/hybrid vectors remain explicitly rejected; the four resumable SDK
endpoints remain explicit 501. These are declared scope decisions. The SDK
1.2.3 `_ENDPOINTS` inventory has 16 entries: twelve implemented, four 501; REST
random/rename are additionally implemented. See the
[SDK source](https://github.com/upstash/vector-js) and
[REST endpoint documentation](https://upstash.com/docs/vector/api/endpoints).

Local test/smoke containers, private networks, and disposable test volumes were
cleaned by their scripts. Active workspace/branch, unrelated containers, and
unmerged worktrees were preserved. Parent owns merge, old PR/issue resolution,
and final branch/worktree cleanup.
