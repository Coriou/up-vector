# Contributing to up-vector

## Development Setup

1. Install [Bun](https://bun.sh) 1.2+
2. Start Redis Stack: `docker compose -f docker-compose.yml -f docker-compose.dev.yml up redis -d`
3. `bun install`
4. `UPVECTOR_TOKEN=test bun run dev`

## Running Tests

Three test tiers — all must pass before merge:

| Tier | Command | Needs server? |
|------|---------|---------------|
| Unit | `bun test tests/unit` | No |
| Integration | `bun test tests/integration` | Yes (Redis + server) |
| Compatibility | `bun test tests/compatibility` | Yes (Redis + server) |

Or run everything at once:

```bash
./scripts/test-all.sh
```

## SDK Compatibility Tests

The tests in `tests/compatibility/` use the **real `@upstash/vector` SDK** as a client against up-vector. These are the most important tests — they guarantee that actual SDK users won't hit breaking changes.

A weekly CI job also tests against the latest published SDK version to catch incompatibilities early.

When adding a new endpoint or changing response shapes, **add or update compatibility tests first**.

## Code Style

Enforced by [Biome](https://biomejs.dev) — run `bun run lint:fix` before committing.

- Tabs for indentation
- Double quotes
- No semicolons
- 100-char line width

## Pull Requests

- All three test tiers must pass (CI runs automatically)
- Keep PRs focused — one feature or fix per PR
- Update tests for any behavior changes

## Reporting Issues

Open a [GitHub issue](https://github.com/Coriou/up-vector/issues). Include:

- What you expected vs what happened
- `@upstash/vector` SDK version (if applicable)
- up-vector version or commit hash
- Steps to reproduce
