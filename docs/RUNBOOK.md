# Maintenance Runbook

How up-vector stays trustworthy without heroics. The system has two layers:

1. **Always-on automation** (GitHub Actions + Dependabot) — watches everything that
   floats outside our lockfile and turns every signal into a labeled GitHub issue.
2. **Scheduled deep audits** (agent fan-out) — adversarial review passes that hunt
   for what automation cannot see: behavioral bugs, parity gaps, unsafe edge cases.

Principles:

- Nothing floats silently: Bun, Redis Stack, the SDK, and the npm advisory DB are
  all either pinned or canaried. A floating version is allowed only as an explicit
  canary whose job is to fail loudly.
- Pins never move because a version exists. They move when the corresponding
  canary proves the new version green.
- Every automated signal lands as an issue with a stable label. No signal lives
  only in a log nobody reads.

Verified baseline at runbook creation (2026-08-22): **381 tests** — 247 unit /
60 integration / 74 SDK compatibility — green on Bun 1.3.6-pinned CI, local Bun
1.3.14, Redis Stack `7.4.0-v8`, hono `4.13.3`.

## Automation inventory

| Mechanism | When | Watches | Failure signal |
|---|---|---|---|
| `test.yml` | push / PR touching code | our code vs pinned Bun 1.3.6 + Redis Stack `7.4.0-v8` | red CI on the PR |
| `compat.yml` | Mon 09:00 UTC | `@upstash/vector@latest` against us | issue labeled `sdk-compat` |
| `maintenance.yml` | Mon 09:30 UTC | npm advisory DB, `bun@latest`, `redis-stack-server:latest`, Docker artifact | issues labeled `security` / `maintenance` |
| `dependabot.yml` | weekly | bun deps, GitHub Actions pins, Dockerfile base image, compose Redis pin | PRs labeled `dependencies` |

## Triage playbook

### `sdk-compat` issue (Upstash shipped an SDK change)

1. Read the workflow log; identify failing tests.
2. Diff the SDK changelog between our pin and the failing version.
3. Dense-surface behavior change → fix forward in `src/`, extend
   `tests/compatibility/`, merge. Breaking change outside our dense scope →
   pin the last-green SDK version via a Dependabot `ignore` rule and open a
   tracking issue describing the gap.
4. Do not leave main red past Monday — downstream users mirror this check.

### `security` issue (`bun audit` found advisories)

1. For each advisory, check whether we actually exercise the vulnerable code
   path (e.g. which Hono middlewares/helpers `src/server.ts` mounts).
2. Fix available within existing semver range → bump, run `./scripts/test-all.sh`,
   merge same week. Moderate-or-worse with no fix → assess exploitability of our
   specific surface, document the analysis in the issue, decide mitigation.
3. Reference point: hono advisories GHSA-8j4g-w8fx-2239, GHSA-f23p-vx2j-j53r,
   GHSA-79qm-7rj5-m7r9, GHSA-54fx-42gc-7vw4 were all resolved by 4.12.34;
   we ship ≥ 4.13.3.

### `maintenance` issue (canary or smoke failed)

- **canary-bun failed** → newer Bun broke something. Hold `BUN_PIN`
  (`maintenance.yml`, `test.yml`, `compat.yml`) and the Dockerfile base tag;
  reproduce locally with `bun@latest`; bump only after a green full gate.
- **canary-redis failed** → RediSearch drifted. Hold `REDIS_PIN` everywhere
  including `docker-compose.yml` (users deploy that pin). Reproduce against
  `redis-stack-server:latest` locally before changing any `FT.*` usage in
  `src/translate/index.ts` or route queries.
- **docker-smoke failed** → the artifact path users actually deploy is broken.
  This is a release blocker; fix before anything ships.

### Dependabot PRs

- Merge after CI green. `@upstash/vector` PRs always get individual review —
  the SDK is our compatibility contract, never batch it with tooling bumps.
- `typescript` major updates are deliberately ignored in config (7.x hold)
  until a dedicated migration pass.

## Release gate

Before tagging or publishing any release:

- [ ] `./scripts/test-all.sh` fully green; record counts in the release notes
- [ ] `bun audit --json` clean
- [ ] Latest weekly `compat.yml` + `maintenance.yml` runs green (re-run via
      `workflow_dispatch` if stale)
- [ ] Docker build + smoke path green
- [ ] `README.md` / `CLAUDE.md` env tables and test counts still truthful

## Deep audit (the workflowz)

Run quarterly, before notable releases, and after upstream majors (SDK, Bun,
Redis Stack). Executed with the agent harness as a parallel fan-out; the
procedure is deterministic and re-runnable. Past runs land in `docs/audits/`.

1. **Finders (parallel, mutually blind)** — one agent per dimension:
   - *protocol correctness*: Float32 little-endian round-trips, RESP3 shape
     handling, score normalization per metric (COSINE / EUCLIDEAN /
     DOT_PRODUCT), binary-safe Redis paths (`redis.send`)
   - *security*: auth bypass vectors, injection through ids / namespaces /
     filter strings, header handling, body-limit enforcement
   - *resource safety*: topK / dimension bombs, timeout coverage, unbounded
     over-fetch in filter evaluation, shutdown drain
   - *parity*: `_ENDPOINTS` inventory of the installed `@upstash/vector` vs
     `src/routes/*` vs the live Upstash REST docs — every endpoint must be
     supported, explicitly rejected, or explicitly 501
   - *concurrency & self-heal*: Redis client re-init, lazy `FT.CREATE` races,
     graceful shutdown during in-flight writes
   Each finder returns structured findings `{file, line, title, evidence,
   severity}` — no vibes, citations required.
2. **Refutation (parallel)** — one skeptic per finding, prompted to REFUTE,
   defaulting to "refuted" when evidence is weak. A finding survives only with
   concrete file/line evidence the skeptic cannot break.
3. **Synthesis** — survivors are deduplicated, severity-ranked, and turned into
   issues or immediate fixes. Disputed findings are reported as disputed, never
   silently dropped.

Scope guardrails for finders (things that look like bugs but are decisions):
sparse/hybrid vectors are intentionally rejected; resumable query endpoints are
intentionally 501; metadata filtering is intentionally app-level over-fetch in
v1; score values approximate Upstash cloud but are not bit-identical.
