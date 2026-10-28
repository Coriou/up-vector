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

Verified baseline (2026-10-28): **475 tests** — 340 unit / 61 integration /
74 SDK compatibility — green locally on Bun 1.4.0 and latest 1.4.4, Redis Stack
`7.4.0-v8` (Redis 7.4.7), SDK 1.2.3 (registry latest), Hono 4.13.14, Zod 4.6.7.
`bun audit --json` returns `{}`. Bun CI and Docker pins moved to **1.4.4 only
after the full canary passed**. Redis `latest` has the identical digest as the
existing pin; Redis pin unchanged. Remote PR CI is a separate check.
Full evidence, PR25 reconciliation, advisory triage, and open risks:
[`audits/2026-10-28-maintenance.md`](audits/2026-10-28-maintenance.md).
Historical baseline: 465 tests in September's audit, 444 after August's fixes,
383 at runbook creation.

## Automation inventory

| Mechanism | When | Watches | Failure signal |
|---|---|---|---|
| `test.yml` | push / PR touching code | our code vs pinned Bun 1.4.4 + Redis Stack `7.4.0-v8` | red CI on the PR |
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
   we ship 4.13.14. The 2026-10-28 audit also resolves the six advisories
   tracked by #44 (and earlier subsets #38/#30).

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
- [ ] Docker build + `./scripts/docker-smoke.sh` green (assert health, auth, stored query result)
- [ ] `README.md` / `CLAUDE.md` env tables and test counts still truthful

## Local gate isolation

`./scripts/test-all.sh` allocates a unique Compose project and disposable volume,
selects available ports, probes Redis/HTTP readiness, and cleans up only its own
server and containers (also on failure). It intentionally supplies deterministic
test credentials and a fake embedding provider; it does not reuse the deployment
Redis URL or token. Select another Bun through PATH to run the same complete gate
as a runtime canary. The Docker smoke script uses a private network and no host
ports, and accepts optional image and Redis tag arguments.

## Deep audit (the workflowz)

The deterministic, re-runnable procedure lives in
[`docs/workflows/deep-audit.md`](./workflows/deep-audit.md): finder
dimensions and prompts, refuter rules (default-refute), synthesis and exit
criteria, and the scope-guardrails list. Execute it with the agent harness
as a parallel fan-out — or any agent runner, including a future scheduled CI
job — exactly as written.

Cadence: quarterly, before notable releases, and after upstream majors (SDK,
Bun, Redis Stack). Past runs land in `docs/audits/` — latest:
[2026-09-06](./audits/2026-09-06-deep-audit.md) (17 raw findings, 12
survivors, 8 fixed in-pass with regression tests, 3 open issues #22 #23
#24, 5 refuted).
