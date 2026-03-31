# up-vector

[![CI](https://github.com/Coriou/up-vector/actions/workflows/test.yml/badge.svg)](https://github.com/Coriou/up-vector/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun)](https://bun.sh)

Self-hosted [Upstash Vector](https://upstash.com/docs/vector/overall/getstarted)-compatible HTTP proxy backed by [Redis Stack](https://redis.io/docs/latest/operate/oss_and_stack/install/install-stack/).

Drop-in replacement for `@upstash/vector` — point the SDK at your own server instead of Upstash's cloud. Uses Redis Stack (RediSearch) for HNSW vector indexing. Sibling project to [up-redis](https://github.com/Coriou/up-redis) (same idea, but for vectors).

## Quick Start

```bash
git clone https://github.com/Coriou/up-vector.git
cd up-vector
cp .env.example .env
# Edit .env — set UPVECTOR_TOKEN to a secret of your choice

docker compose up -d
```

The API is now available at `http://localhost:8080`.

## Usage with @upstash/vector

Just swap the URL and token — everything else stays the same:

```typescript
import { Index } from "@upstash/vector"

const index = new Index({
  url: "http://localhost:8080",  // ← your up-vector instance
  token: "your-token-here",
})

// Upsert vectors
await index.upsert([
  { id: "doc-1", vector: [0.1, 0.2, 0.3], metadata: { title: "Hello" } },
  { id: "doc-2", vector: [0.4, 0.5, 0.6], metadata: { title: "World" } },
])

// Query with KNN similarity search
const results = await index.query({
  vector: [0.1, 0.2, 0.3],
  topK: 5,
  includeMetadata: true,
  filter: "title = 'Hello'",
})

// All SDK methods work: fetch, delete, update, range, reset, info, namespaces
```

## REST API

Works with any language — just send HTTP requests:

```bash
# Upsert vectors
curl -X POST http://localhost:8080/upsert \
  -H "Authorization: Bearer your-token-here" \
  -H "Content-Type: application/json" \
  -d '[{"id":"doc-1","vector":[0.1,0.2,0.3],"metadata":{"title":"Hello"}}]'

# Query
curl -X POST http://localhost:8080/query \
  -H "Authorization: Bearer your-token-here" \
  -H "Content-Type: application/json" \
  -d '{"vector":[0.1,0.2,0.3],"topK":5,"includeMetadata":true}'
```

## API Compatibility

Implements the [Upstash Vector REST API](https://upstash.com/docs/vector/api/endpoints), validated by 198 tests including 65 using the real `@upstash/vector` SDK.

| Endpoint | Status |
|----------|--------|
| `POST /upsert[/{namespace}]` | Supported |
| `POST /query[/{namespace}]` | Supported (KNN + metadata filtering) |
| `POST /fetch[/{namespace}]` | Supported (by IDs and prefix) |
| `POST /delete[/{namespace}]` | Supported (by IDs, prefix, or filter) |
| `POST /update[/{namespace}]` | Supported (OVERWRITE and PATCH modes) |
| `POST /range[/{namespace}]` | Supported (cursor pagination) |
| `DELETE /reset[/{namespace}]` | Supported (single or all namespaces) |
| `GET /info` | Supported |
| `GET /list-namespaces` | Supported |
| `DELETE /delete-namespace/{ns}` | Supported |

Not implemented: `/upsert-data`, `/query-data` (require server-side embedding models), `/resumable-query*` (stateful cursors).

### Metadata Filtering

Full support for the Upstash filter syntax:

```
status = 'active' AND score >= 0.8
genre IN ('comedy', 'drama') AND year > 2020
tags CONTAINS 'featured'
geography.continent = 'Asia'
title GLOB 'The *' OR (rating >= 4.5 AND reviews > 100)
HAS FIELD premium
```

All operators: `=`, `!=`, `<`, `<=`, `>`, `>=`, `GLOB`, `NOT GLOB`, `IN`, `NOT IN`, `CONTAINS`, `NOT CONTAINS`, `HAS FIELD`, `HAS NOT FIELD`, `AND`, `OR`, parentheses, dot notation, array indexing.

## When to Use This

**Good fit if you:**
- Want self-hosted vector search with zero vendor lock-in
- Run RAG workloads with topK 5-20 and under 100K vectors
- Already run Redis Stack (or want a single Docker Compose setup)
- Want the `@upstash/vector` SDK API without a cloud dependency

**Use Upstash Cloud instead if you need:**
- Server-side embeddings (built-in embedding models)
- Sparse or hybrid vector search
- DiskANN-level scale (millions of vectors)
- Managed infrastructure with zero ops

| Aspect | Upstash | up-vector |
|--------|---------|-----------|
| ANN algorithm | DiskANN | HNSW (RediSearch) |
| Metadata filtering | Server-side | App-level (over-fetch + filter) |
| Embedding endpoints | Built-in models | Not supported — bring your own vectors |

For RAG workloads with topK of 5-20 and <100K vectors, the differences are negligible.

## Configuration

All environment variables are prefixed `UPVECTOR_`:

| Variable | Default | Description |
|----------|---------|-------------|
| `UPVECTOR_TOKEN` | — | **Required.** Bearer token for API authentication |
| `UPVECTOR_REDIS_URL` | `redis://localhost:6379` | Redis Stack connection URL |
| `UPVECTOR_PORT` | `8080` | HTTP listen port |
| `UPVECTOR_HOST` | `0.0.0.0` | HTTP listen host |
| `UPVECTOR_METRIC` | `COSINE` | Distance metric: `COSINE`, `EUCLIDEAN`, `DOT_PRODUCT` |
| `UPVECTOR_DIMENSION` | auto-detected | Fixed vector dimension (auto-detected from first upsert if omitted) |
| `UPVECTOR_LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error` |
| `UPVECTOR_LOG_FORMAT` | `json` | Log format: `json` (structured) or `text` (human-readable) |
| `UPVECTOR_SHUTDOWN_TIMEOUT` | `30000` | Max milliseconds to wait for request drain on shutdown |
| `UPVECTOR_REQUEST_TIMEOUT` | `30000` | Per-request timeout in milliseconds (`0` = disabled) |
| `UPVECTOR_METRICS` | `false` | Enable Prometheus metrics at `GET /metrics` |

## Health & Monitoring

**Health check** — no auth required:

```bash
# Lightweight probe (used by Docker HEALTHCHECK)
curl http://localhost:8080/
# → 200 "OK" or 503 "Shutting Down"

# Rich health endpoint with dependency status
curl http://localhost:8080/health
# → {"status":"ok","redis":"connected"}
# → {"status":"degraded","redis":"disconnected"} (503)
# → {"status":"shutting_down","redis":"..."} (503)
```

**Prometheus metrics** — enable with `UPVECTOR_METRICS=true`:

```bash
curl http://localhost:8080/metrics
```

Exposes `http_requests_total{method,status}`, `http_request_duration_seconds` histogram, and `upvector_info` gauge in Prometheus exposition format.

**Structured logging** — JSON by default (set `UPVECTOR_LOG_FORMAT=text` for dev). Includes request IDs (`X-Request-ID` header), method, path, status, and duration for every request.

## Architecture

```
@upstash/vector SDK ──HTTP REST──▶ up-vector (Hono/Bun) ──Redis protocol──▶ Redis Stack (RediSearch)
```

- **Runtime:** [Bun](https://bun.sh) — native TypeScript, fastest JS runtime
- **HTTP:** [Hono](https://hono.dev) v4 — lightweight, fast
- **Redis:** Bun.redis (native, zero-dep) — `send()` for raw `FT.*` RediSearch commands
- **Validation:** [Zod](https://zod.dev) v3 — request body validation

Key design decisions: lazy index creation on first upsert, dimension auto-detection, namespace isolation via Redis key prefixes, app-level metadata filtering with over-fetch strategy, score normalization to Upstash's 0-1 range.

See [PLAN.md](./PLAN.md) for full architecture details and project structure.

## Development

```bash
bun install              # Install dependencies
bun run dev              # Dev server with --watch
bun run build            # Bundle to dist/index.js
bun run lint             # Biome check
bun run lint:fix         # Biome auto-fix
bun run typecheck        # TypeScript check
```

### Testing

198 tests across three tiers:

| Tier | Tests | Purpose |
|------|-------|---------|
| **Unit** | 110 | Filter parser, vector encode/decode, score normalization, key naming |
| **Integration** | 23 | End-to-end against Redis Stack |
| **SDK Compatibility** | 65 | Real `@upstash/vector` SDK against up-vector |

```bash
./scripts/test-all.sh    # Run everything (starts Redis + server automatically)
```

The compatibility tests are the ultimate validation — they use the actual `@upstash/vector` TypeScript SDK, exercising the exact HTTP paths and request formats that production apps use. A weekly CI job also tests against the latest SDK version to catch incompatibilities early.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup and contribution guidelines.

## Deployment

### Docker Compose (standalone)

```bash
cp .env.example .env     # Set UPVECTOR_TOKEN
docker compose up -d     # Starts up-vector + Redis Stack
```

### With up-redis (side-by-side)

Both services can share the same Redis Stack instance — up-redis handles standard Redis commands, up-vector handles vector search:

```yaml
services:
  redis-stack:
    image: redis/redis-stack-server:latest

  up-redis:
    image: ghcr.io/coriou/up-redis:latest
    environment:
      UPREDIS_TOKEN: ${UPREDIS_TOKEN}
      UPREDIS_REDIS_URL: redis://redis-stack:6379

  up-vector:
    image: ghcr.io/coriou/up-vector:latest
    environment:
      UPVECTOR_TOKEN: ${UPVECTOR_TOKEN}
      UPVECTOR_REDIS_URL: redis://redis-stack:6379
```

## License

MIT
