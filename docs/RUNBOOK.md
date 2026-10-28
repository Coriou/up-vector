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

Verified baseline (2026-10-28, Astra follow-up): **495 tests** — 353 unit /
68 integration / 74 SDK compatibility — green locally on pinned Bun **1.4.4**,
Redis Stack `7.4.0-v8` (Redis 7.4.7), SDK 1.2.3, Hono 4.13.14, Zod 4.6.7.
Typecheck, lint, build, `bun audit --json` (`{}`), and production Docker smoke
passed. The untouched `5be3db9` baseline had 475 passing tests. The earlier
maintenance pass also tested Bun 1.4.0; this follow-up does not claim that
runtime was retested. Remote PR CI remains a separate release gate.
Evidence and release limitations:
[`audits/2026-10-28-astra-audit.md`](audits/2026-10-28-astra-audit.md).
Dependency/advisory reconciliation remains in the historical
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
- [ ] Latest `test.yml`, `compat.yml`, and `maintenance.yml` runs for the exact
      final main SHA green (dispatch missing runs; older green SHAs do not qualify)
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

## Manual GHCR publication

`publish.yml` publishes **linux/amd64 only**, using the repository's automatic
`GITHUB_TOKEN` with `contents: read`, `actions: read`, and `packages: write`.
No personal token or npm publication is needed. It runs only on manual dispatch
from `main`, checks out the exact dispatch SHA, and serializes publications.
It builds locally and runs `scripts/docker-smoke.sh` on that exact image before
registry login. OCI source/revision labels identify the repository and commit.

After merging an approved PR, record the final main SHA and dispatch the gates:

```sh
gh api repos/Coriou/up-vector/git/ref/heads/main --jq '.object.sha'
gh workflow run test.yml --repo Coriou/up-vector --ref main
gh workflow run compat.yml --repo Coriou/up-vector --ref main
gh workflow run maintenance.yml --repo Coriou/up-vector --ref main
```

Inspect the runs in Actions (or `gh run list --repo Coriou/up-vector --branch main
--commit <full-main-sha>`). **Test**, **SDK Compatibility (latest)**, and
**Maintenance** must each have their latest run for that same SHA completed with
`success`. PR merge-ref checks and older green commits do not qualify. If main
moves, repeat for the new SHA. No workflow waits for gates: missing, pending,
failed, or cancelled runs cause a clear publication failure before any push.

Only after all three gates are green, dispatch:

```sh
gh workflow run publish.yml --repo Coriou/up-vector --ref main
```

The workflow rechecks gates/main after smoke, pushes `sha-<full-40-character-sha>`
and then `latest`, and records the GHCR `sha256` digest in its step summary.
Tags are mutable; deploy the recorded `ghcr.io/coriou/up-vector@sha256:...`
reference when immutable identity matters. Pushes are not transactional: if
`latest` fails after the SHA tag succeeds, the summary still records the digest.
No Git version tag or GitHub release is created. Concurrent commits to main can
still occur after the final check; keep main stable during publication.

For the first publication, check package visibility in GitHub Packages and set
it to public if needed for anonymous pulls promised by the deployment example.
If the package already exists, grant this repository Actions access to it; do
not work around missing package permissions by adding a personal token. A green
workflow plus its registry digest establishes publication; this runbook does
not claim the image has already been published.

To reproduce the local artifact check on an amd64 Docker host at the target SHA:

```sh
docker build --platform linux/amd64 -t up-vector:release-check .
./scripts/docker-smoke.sh up-vector:release-check 7.4.0-v8
```

The gate script uses GitHub's [workflow-run API](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-workflow);
token-based publication follows GitHub's [GHCR guidance](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images).
