# up-vector

[![CI](https://github.com/Coriou/up-vector/actions/workflows/test.yml/badge.svg)](https://github.com/Coriou/up-vector/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun)](https://bun.sh)

Self-hosted [Upstash Vector](https://upstash.com/docs/vector/overall/getstarted)-compatible HTTP proxy for dense-vector and raw-text RAG workloads, backed by [Redis Stack](https://redis.io/docs/latest/operate/oss_and_stack/install/install-stack/).

Drop-in replacement for the implemented dense-vector `@upstash/vector` SDK surface, plus `/upsert-data` and `/query-data` when you configure a server-side embedding provider. It is not a full Upstash Vector clone: sparse, hybrid, Upstash-hosted model behavior, and resumable query cursors are still unsupported. Uses Redis Stack (RediSearch) for HNSW vector indexing. Sibling project to [up-redis](https://github.com/Coriou/up-redis) (same idea, but for vectors).

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

// Dense-vector SDK methods work: fetch, delete, update, range, reset, info, namespaces
```

## RAG Quickstart

### Client-generated embeddings

Use this path when your application already calls OpenAI, Vercel AI SDK, LangChain, or another embedding provider. This is the most explicit and portable mode.

```typescript
const chunkEmbedding = await embed("Upstash Vector stores embeddings")

await index.upsert({
  id: "chunk-1",
  vector: chunkEmbedding,
  data: "Upstash Vector stores embeddings",
  metadata: { source: "docs" },
})

const queryEmbedding = await embed("Where are embeddings stored?")
const matches = await index.query({
  vector: queryEmbedding,
  topK: 5,
  includeData: true,
  includeMetadata: true,
})
```

### Server-generated embeddings

Set an embedding provider on the up-vector server, then use the current SDK's raw-text path. The SDK automatically sends these calls to `/upsert-data` and `/query-data`.

```bash
UPVECTOR_EMBEDDING_PROVIDER=openai
UPVECTOR_EMBEDDING_API_KEY=sk-...
UPVECTOR_EMBEDDING_MODEL=text-embedding-3-small
# Optional but recommended when you want a fixed index dimension:
UPVECTOR_EMBEDDING_DIMENSION=1536
```

```typescript
await index.upsert({
  id: "chunk-1",
  data: "Upstash Vector stores embeddings",
  metadata: { source: "docs" },
})

const matches = await index.query({
  data: "Where are embeddings stored?",
  topK: 5,
  includeData: true,
  includeMetadata: true,
})
```

`/upsert-data` stores the original text in the vector's `data` field after embedding it. `/query-data` embeds the query text, then returns the same result shape as `/query`.

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

# Upsert raw text through the configured embedding provider
curl -X POST http://localhost:8080/upsert-data \
  -H "Authorization: Bearer your-token-here" \
  -H "Content-Type: application/json" \
  -d '[{"id":"doc-1","data":"Upstash Vector stores embeddings","metadata":{"source":"docs"}}]'

# Query raw text through the configured embedding provider
curl -X POST http://localhost:8080/query-data \
  -H "Authorization: Bearer your-token-here" \
  -H "Content-Type: application/json" \
  -d '{"data":"Where are embeddings stored?","topK":5,"includeData":true}'
```

## API Compatibility

Implements the dense-vector subset of the [Upstash Vector REST API](https://upstash.com/docs/vector/api/endpoints), plus dense `/upsert-data` and `/query-data` through a configurable embedding provider. Validated by 346 tests including 74 using the real `@upstash/vector` SDK.

| Surface | Status | Notes |
|----------|--------|-------|
| Dense `POST /upsert[/{namespace}]` | Supported | Dense vectors, metadata, optional `data`; re-upsert replaces omitted metadata/data |
| Dense `POST /query[/{namespace}]` | Supported | KNN + metadata filtering; batch query supported |
| `POST /upsert-data[/{namespace}]` | Supported | Dense only; requires `UPVECTOR_EMBEDDING_PROVIDER`; stores raw text as `data` |
| `POST /query-data[/{namespace}]` | Supported | Dense only; requires `UPVECTOR_EMBEDDING_PROVIDER`; same result shape as `/query` |
| `GET/POST /fetch[/{namespace}]` | Supported | IDs and prefix; include metadata/vectors/data |
| `DELETE/POST /delete[/{namespace}]` | Supported | IDs, prefix, or filter |
| `POST /update[/{namespace}]` | Supported | Dense vector, data, OVERWRITE and PATCH metadata |
| `GET/POST /range[/{namespace}]` | Supported | Offset cursor pagination |
| `GET/POST /random[/{namespace}]` | Supported | Returns one random dense vector or `null` |
| `DELETE/POST /reset[/{namespace}]` | Supported | Single namespace or all namespaces; resets preserve namespace entries |
| `GET/POST /info` | Supported | Reports `indexType: "DENSE"` and namespace counts |
| Namespace list/delete/rename | Supported | `list-namespaces`, `delete-namespace`, `rename-namespace` |
| Sparse indexes and sparse vectors | Unsupported | Requests with `sparseVector` are rejected; see [sparse/hybrid architecture](./docs/architecture/sparse-hybrid.md) |
| Hybrid indexes and fusion/query modes | Unsupported | No dense+sparse fusion yet |
| Resumable query endpoints | Unsupported | Return explicit `501`; no cursor/session parity |
| Upstash-hosted embedding models | Partial | OpenAI-compatible self-host/provider path only, not Upstash's hosted model catalog |

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
- Upstash-hosted embedding models without operating your own provider credentials
- Sparse or hybrid vector search
- Resumable query cursors
- DiskANN-level scale (millions of vectors)
- Managed infrastructure with zero ops

| Aspect | Upstash | up-vector |
|--------|---------|-----------|
| ANN algorithm | DiskANN | HNSW (RediSearch) |
| Metadata filtering | Server-side | App-level (over-fetch + filter) |
| Embedding endpoints | Built-in hosted models | OpenAI-compatible provider or bring your own vectors |

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
| `UPVECTOR_REDIS_REINIT_AFTER_MS` | `15000` | Recreate the Redis client after it has been continuously unhealthy this long, so the proxy self-heals in-process once Redis returns (`0` = disabled) |
| `UPVECTOR_METRICS` | `false` | Enable Prometheus metrics at `GET /metrics` |
| `UPVECTOR_MAX_BODY_SIZE` | `33554432` | Max request body size in bytes |
| `UPVECTOR_EMBEDDING_PROVIDER` | `disabled` | `disabled`, `openai`, or `fake`. `fake` is deterministic and intended for tests/dev only |
| `UPVECTOR_EMBEDDING_MODEL` | `text-embedding-3-small` | Model name sent to the OpenAI-compatible `/embeddings` endpoint |
| `UPVECTOR_EMBEDDING_DIMENSION` | provider default | Expected embedding dimension. Also sent as `dimensions` to OpenAI-compatible providers when set |
| `UPVECTOR_EMBEDDING_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible API base URL |
| `UPVECTOR_EMBEDDING_API_KEY` | — | Required when `UPVECTOR_EMBEDDING_PROVIDER=openai` |
| `UPVECTOR_EMBEDDING_TIMEOUT_MS` | `10000` | Per embedding request timeout (`0` = disabled) |
| `UPVECTOR_EMBEDDING_RETRIES` | `2` | Retries for provider timeouts, HTTP 429, and HTTP 5xx responses |

Operational caveats for `/upsert-data` and `/query-data`:
- The provider is called synchronously inside the request path. Size your timeout and upstream rate limits accordingly.
- `UPVECTOR_EMBEDDING_DIMENSION` must match `UPVECTOR_DIMENSION` when both are set.
- Existing namespaces keep their original dense dimension; raw-text queries/upserts fail loudly if the provider returns a different dimension.
- `fake` embeddings are deterministic but not semantically meaningful. They exist so CI and local tests do not need API keys.

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
- **Validation:** [Zod](https://zod.dev) v4 — request body validation
- **Lint/format:** [Biome](https://biomejs.dev) v2 — fast formatter and static checks

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

346 tests across three tiers:

| Tier | Tests | Purpose |
|------|-------|---------|
| **Unit** | 222 | Filter parser, embedding providers, vector encode/decode, score normalization, key naming, middleware/config hardening |
| **Integration** | 50 | End-to-end REST behavior against Redis Stack, including raw-text data endpoints |
| **SDK Compatibility** | 74 | Real `@upstash/vector` SDK against up-vector |

```bash
./scripts/test-all.sh    # Run everything (starts Redis + server automatically)
```

The test script honors `UPVECTOR_REDIS_PORT` and `UPVECTOR_PORT`, and otherwise chooses free local ports before starting Redis/server.

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
