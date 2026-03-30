# up-vector — Implementation Plan

A self-hosted, Upstash Vector-compatible HTTP proxy backed by Redis Stack. Drop-in replacement for `@upstash/vector` — point the SDK at your own server instead of Upstash's cloud.

Same spirit as [SRH](https://github.com/hiett/serverless-redis-http) (serverless-redis-http), but for vectors.

---

## Architecture

```
@upstash/vector SDK (your app, Vercel edge, anywhere)
        |
        | HTTP REST (Upstash Vector protocol)
        |
   ┌────▼─────────────────────┐
   │       up-vector           │
   │  (Hono on Bun, ~800 LOC) │
   │                           │
   │  Accepts Upstash Vector   │
   │  REST calls, translates   │
   │  to Redis Stack FT.*      │
   │  commands                 │
   └────┬─────────────────────┘
        |
        | Redis protocol (FT.CREATE, FT.SEARCH, HSET, DEL...)
        |
   ┌────▼─────────────────────┐
   │    Redis Stack            │
   │  (redis-stack-server)     │
   │                           │
   │  RediSearch module does   │
   │  HNSW vector indexing,    │
   │  KNN search, filtering   │
   └──────────────────────────┘
```

**Key design decisions:**

1. **Separate from SRH** — Different protocol (resource REST vs command-array forwarding), different concerns. Clean separation. Can run alongside SRH against the same Redis Stack, or standalone with its own.
2. **Own Redis Stack in compose** — Self-contained, portable. One `docker compose up` and it works. Can also connect to an external Redis Stack via env var.
3. **Bun runtime** — Native TypeScript, fastest JS runtime, built-in test runner.
4. **Hono framework** — Lightweight, fast, excellent middleware, portable (Bun/Node/Deno/Workers).

---

## Tech Stack

| Layer | Choice | Version | Why |
|-------|--------|---------|-----|
| Runtime | Bun | latest (1.2+) | Native TS, fastest JS runtime, built-in test runner |
| HTTP | Hono | v4 | Lightweight, fast, great middleware, portable |
| Redis client | Bun.redis | built-in | Native Bun Redis client, 7.9x faster than Bun.redis, `send()` for raw FT.* commands, zero deps |
| Validation | Zod | v3 | Request body validation, type inference |
| Linting/Format | Biome | v1 | Fast, modern, replaces ESLint+Prettier |
| Testing | Bun test | built-in | Fast, Jest-compatible API |
| Container | Bun Alpine | oven/bun:alpine | Minimal image size |
| Vector backend | Redis Stack | latest (7.4+) | RediSearch HNSW, production-grade, FT.* commands |

---

## API Compatibility Matrix

### Endpoints — Full Upstash Vector REST API

The `@upstash/vector` SDK sends ALL requests as HTTP POST with JSON body. We support both the SDK's POST-only pattern and the documented HTTP methods for curl/raw usage.

| Endpoint | SDK Method | Priority | Status | Notes |
|----------|-----------|----------|--------|-------|
| `POST /upsert[/{ns}]` | POST | P0 | Planned | Core — HSET + lazy FT.CREATE |
| `POST /query[/{ns}]` | POST | P0 | Planned | Core — FT.SEARCH KNN |
| `POST /fetch[/{ns}]` | POST | P0 | Planned | Core — HGETALL per ID |
| `POST /delete[/{ns}]` | POST | P0 | Planned | Core — DEL keys |
| `POST /update[/{ns}]` | POST | P0 | Planned | Core — HSET partial update |
| `POST /range[/{ns}]` | POST | P0 | Planned | Core — SCAN/FT.SEARCH with LIMIT |
| `DELETE /reset[/{ns}]` | POST | P0 | Planned | FT.DROPINDEX + key cleanup |
| `GET /info` | POST | P0 | Planned | FT.INFO + key count |
| `GET /list-namespaces` | POST | P1 | Planned | SMEMBERS on namespace registry |
| `DELETE /delete-namespace/{ns}` | POST | P1 | Planned | Drop index + keys + registry entry |
| `GET /` | GET | P0 | Planned | Health check |
| `POST /upsert-data[/{ns}]` | POST | P2 | Deferred | Requires server-side embedding model |
| `POST /query-data[/{ns}]` | POST | P2 | Deferred | Requires server-side embedding model |
| `POST /resumable-query[/{ns}]` | POST | P2 | Deferred | Stateful cursors |
| `POST /resumable-query-data[/{ns}]` | POST | P2 | Deferred | Stateful cursors + embedding |
| `POST /resumable-query-next` | POST | P2 | Deferred | Stateful cursors |
| `POST /resumable-query-end` | POST | P2 | Deferred | Stateful cursors |

### Response Envelope

Every response follows the Upstash convention:

```json
// Success
{ "result": <data> }

// Error
{ "error": "<message>", "status": <http_status_code> }
```

### Authentication

`Authorization: Bearer <token>` header on every request. Token validated against config (env var or file, same pattern as SRH).

---

## Redis Stack Translation Mapping

### Data Model

Each vector is stored as a Redis Hash:

```
Key:    v:{namespace}:{id}
Fields:
  vec       → binary blob (Float32Array as Buffer)
  metadata  → JSON string
  data      → raw string (optional, for the `data` field)
  id        → string (redundant with key, but needed for FT.SEARCH result parsing)
```

Sparse vectors (if implemented later):
```
  svec_idx  → binary blob (Int32Array of indices)
  svec_val  → binary blob (Float32Array of values)
```

### Index Management

One RediSearch index per namespace, created lazily on first upsert:

```
FT.CREATE idx:{namespace}
  ON HASH
  PREFIX 1 v:{namespace}:
  SCHEMA
    vec VECTOR HNSW 6
      TYPE FLOAT32
      DIM {dimension}          ← detected from first upsert
      DISTANCE_METRIC {metric} ← from config (COSINE default)
    metadata TAG SEPARATOR ""  ← for existence checks
    id TAG                     ← for exact match lookups
```

Metadata field indexing is the tricky part — RediSearch requires fields to be declared in the schema. Options:

1. **Dynamic re-indexing**: Track metadata fields seen, ALTER index when new fields appear. Complex, fragile.
2. **JSON module**: Use RedisJSON + FT.CREATE ON JSON with JSONPath. More flexible for nested metadata. Requires Redis Stack (which we have).
3. **Metadata-as-JSON-string + application-level filtering**: Store metadata as JSON string, do KNN search in Redis, filter in application code. Simple but less efficient for large result sets.

**Recommended: Option 3 for v1, upgrade to Option 2 for v2.**

Rationale: Application-level metadata filtering is simpler to implement correctly and handles the full Upstash filter syntax without being limited by RediSearch's schema model. For RAG workloads with topK of 5-20, filtering a few extra results in-app is negligible. For production at scale, upgrade to RedisJSON indexing.

### Command Translation

| Upstash Vector | Redis Stack Commands |
|---|---|
| **upsert** | `HSET v:{ns}:{id} vec <blob> metadata <json> data <str> id <id>` (+ lazy `FT.CREATE` on first upsert per namespace) |
| **query** | `FT.SEARCH idx:{ns} "*=>[KNN {topK * overFetchFactor} @vec $BLOB AS score]" PARAMS 2 BLOB <bytes> SORTBY score LIMIT 0 {topK * overFetchFactor} DIALECT 2` → then app-level metadata filter → trim to topK |
| **fetch by IDs** | `HGETALL v:{ns}:{id}` per ID (pipelined) |
| **fetch by prefix** | `SCAN 0 MATCH v:{ns}:{prefix}* COUNT 100` → `HGETALL` per match |
| **delete by IDs** | `DEL v:{ns}:{id1} v:{ns}:{id2} ...` |
| **delete by prefix** | `SCAN` + `DEL` (batched) |
| **delete by filter** | `FT.SEARCH` (broad) → app-level filter → `DEL` matching keys |
| **update** | `HSET v:{ns}:{id} [vec <blob>] [metadata <json>] [data <str>]` (partial, only provided fields) |
| **range** | `SCAN {cursor} MATCH v:{ns}:* COUNT {limit}` → `HGETALL` per key |
| **reset namespace** | `FT.DROPINDEX idx:{ns}` + `SCAN` + `DEL` all `v:{ns}:*` keys |
| **reset all** | Drop all `idx:*` indexes + DEL all `v:*` keys |
| **info** | `FT.INFO idx:{ns}` (per namespace) + `SCARD _ns_registry` |
| **list-namespaces** | `SMEMBERS _ns_registry` |
| **delete-namespace** | Drop index + DEL keys + `SREM _ns_registry {ns}` |

### Vector Serialization

Upstash expects `number[]` (JSON float arrays). Redis Stack expects raw binary blobs.

```typescript
// Encode: number[] → Buffer (Float32, little-endian)
function encodeVector(vec: number[]): Buffer {
  const buf = Buffer.alloc(vec.length * 4)
  for (let i = 0; i < vec.length; i++) {
    buf.writeFloatLE(vec[i], i * 4)
  }
  return buf
}

// Decode: Buffer → number[]
function decodeVector(buf: Buffer): number[] {
  const vec: number[] = new Array(buf.length / 4)
  for (let i = 0; i < vec.length; i++) {
    vec[i] = buf.readFloatLE(i * 4)
  }
  return vec
}
```

### Score Normalization

Upstash normalizes all scores to 0-1 range. Redis Stack returns raw distances.

| Metric | Redis Stack returns | Upstash returns | Conversion |
|--------|-------------------|-----------------|------------|
| COSINE | `1 - cosine_similarity` (0 = identical) | `(1 + cosine_similarity) / 2` (1 = identical) | `(1 - (1 - redis_score)) / 2 + 0.5` → `1 - redis_score / 2` |
| EUCLIDEAN | squared L2 distance | `1 / (1 + squared_distance)` | `1 / (1 + redis_score)` |
| DOT_PRODUCT | negative dot product | `(1 + dot_product) / 2` | `(1 + (-redis_score)) / 2` |

---

## Metadata Filter Parser

The most complex component. Upstash uses a SQL-like filter language:

```
population >= 1000000 AND geography.continent = 'Asia'
genre IN ('comedy', 'drama') AND year > 2020
tags CONTAINS 'featured' AND HAS FIELD premium
title GLOB 'The *' OR (rating >= 4.5 AND reviews > 100)
```

### Supported Operators

| Operator | Example | v1 Strategy |
|----------|---------|-------------|
| `=`, `!=` | `status = 'active'` | App-level: parse JSON metadata, compare |
| `<`, `<=`, `>`, `>=` | `price >= 100` | App-level: parse JSON metadata, compare |
| `GLOB`, `NOT GLOB` | `name GLOB 'Ben*'` | App-level: convert to regex, test |
| `IN`, `NOT IN` | `tag IN ('a','b')` | App-level: set membership test |
| `CONTAINS`, `NOT CONTAINS` | `tags CONTAINS 'x'` | App-level: array includes check |
| `HAS FIELD`, `HAS NOT FIELD` | `HAS FIELD email` | App-level: key existence in parsed JSON |
| `AND`, `OR`, `()` | grouped conditions | App-level: boolean combinator tree |
| Dot notation | `geo.country = 'FR'` | App-level: nested field access |
| Array indexing | `items[0] = 'x'` | App-level: array index access |

### Parser Architecture

1. **Tokenizer** — Splits filter string into tokens: identifiers, operators, strings, numbers, parens
2. **AST builder** — Recursive descent parser producing a tree of AND/OR/comparison nodes
3. **Evaluator** — Walks the AST against a parsed metadata JSON object, returns boolean

This is a self-contained module (~200-300 lines). Well-suited for thorough unit testing.

### Over-fetching Strategy

Since filtering happens in application code (v1), we need to fetch more results than `topK` to account for filtered-out vectors:

```typescript
const OVER_FETCH_FACTOR = 3  // Fetch 3x topK from Redis
const MAX_OVER_FETCH = 1000  // Cap at 1000 to prevent memory issues

const fetchCount = Math.min(topK * OVER_FETCH_FACTOR, MAX_OVER_FETCH)
// FT.SEARCH with fetchCount, then filter, then trim to topK
```

If after filtering we have fewer than `topK` results, we can re-query with a larger fetch (doubling strategy). This is a pragmatic approach — for most RAG workloads with light filtering, the first pass will suffice.

---

## Project Structure

```
up-vector/
├── src/
│   ├── index.ts                 # Entry point — starts server
│   ├── server.ts                # Hono app + middleware setup
│   ├── config.ts                # Env var config with Zod validation
│   ├── middleware/
│   │   ├── auth.ts              # Bearer token validation
│   │   ├── error-handler.ts     # Global error → Upstash error envelope
│   │   └── logger.ts            # Request logging
│   ├── redis.ts                 # Bun.redis client, connection management
│   ├── routes/
│   │   ├── health.ts            # GET /
│   │   ├── upsert.ts            # POST /upsert[/{ns}]
│   │   ├── query.ts             # POST /query[/{ns}]
│   │   ├── fetch.ts             # POST /fetch[/{ns}]
│   │   ├── delete.ts            # POST|DELETE /delete[/{ns}]
│   │   ├── update.ts            # POST /update[/{ns}]
│   │   ├── range.ts             # POST /range[/{ns}]
│   │   ├── reset.ts             # POST|DELETE /reset[/{ns}]
│   │   ├── info.ts              # GET|POST /info
│   │   └── namespaces.ts        # list-namespaces, delete-namespace
│   ├── translate/
│   │   ├── vectors.ts           # Float32 encode/decode
│   │   ├── scores.ts            # Distance metric normalization
│   │   ├── keys.ts              # Key naming: v:{ns}:{id}, idx:{ns}
│   │   └── index.ts             # Lazy FT.CREATE management
│   ├── filter/
│   │   ├── tokenizer.ts         # Filter string → tokens
│   │   ├── parser.ts            # Tokens → AST
│   │   ├── evaluator.ts         # AST × metadata → boolean
│   │   └── types.ts             # AST node types
│   └── types.ts                 # Shared types (Vector, QueryResult, etc.)
├── tests/
│   ├── unit/
│   │   ├── filter.test.ts       # Filter parser + evaluator (extensive)
│   │   ├── vectors.test.ts      # Encode/decode roundtrip
│   │   ├── scores.test.ts       # Score normalization
│   │   └── keys.test.ts         # Key generation
│   ├── integration/
│   │   ├── upsert.test.ts       # Against real Redis Stack
│   │   ├── query.test.ts
│   │   ├── fetch.test.ts
│   │   ├── delete.test.ts
│   │   ├── namespaces.test.ts
│   │   └── setup.ts             # Test Redis connection, cleanup
│   └── compatibility/
│       └── README.md            # Instructions for running @upstash/vector test suite
├── docker-compose.yml
├── docker-compose.dev.yml       # Dev overrides (volume mounts, debug)
├── Dockerfile
├── .env.example
├── .gitignore
├── biome.json
├── bunfig.toml
├── package.json
├── tsconfig.json
├── LICENSE
├── README.md
└── PLAN.md                      # This file
```

---

## Configuration

### Environment Variables

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `UPVECTOR_TOKEN` | — | Yes | Bearer token for API auth |
| `UPVECTOR_REDIS_URL` | `redis://localhost:6379` | No | Redis Stack connection URL |
| `UPVECTOR_PORT` | `8080` | No | HTTP listen port |
| `UPVECTOR_HOST` | `0.0.0.0` | No | HTTP listen host |
| `UPVECTOR_DIMENSION` | — | No | Fixed vector dimension (auto-detected from first upsert if omitted) |
| `UPVECTOR_METRIC` | `COSINE` | No | Distance metric: `COSINE`, `EUCLIDEAN`, `DOT_PRODUCT` |
| `UPVECTOR_LOG_LEVEL` | `info` | No | `debug`, `info`, `warn`, `error` |
| `UPVECTOR_MAX_CONNECTIONS` | `10` | No | Redis connection pool size |

### Multi-token mode (future)

Like SRH's file mode, support a JSON config mapping tokens to separate Redis instances / index configs. Not needed for v1.

---

## Implementation Phases

### Phase 1 — Scaffold + Core (this session → next session)

- [x] Project setup (package.json, tsconfig, Docker, Biome)
- [x] PLAN.md
- [ ] Hono server with auth middleware and error handling
- [ ] Redis connection with Bun.redis
- [ ] Vector encode/decode utilities
- [ ] Key naming module
- [ ] Health endpoint (`GET /`)

### Phase 2 — CRUD Operations

- [ ] `POST /upsert` — HSET + lazy FT.CREATE
- [ ] `POST /fetch` — HGETALL (by IDs and prefix)
- [ ] `POST /delete` — DEL (by IDs and prefix)
- [ ] `POST /update` — partial HSET
- [ ] `POST /range` — SCAN-based cursor pagination
- [ ] `DELETE /reset` — drop index + keys

### Phase 3 — Query + Filtering

- [ ] `POST /query` — FT.SEARCH KNN
- [ ] Score normalization (COSINE, EUCLIDEAN, DOT_PRODUCT)
- [ ] Filter tokenizer
- [ ] Filter parser (recursive descent)
- [ ] Filter evaluator
- [ ] Over-fetch + app-level filter + trim pipeline
- [ ] `POST /delete` with filter (fetch → filter → delete)

### Phase 4 — Namespaces + Info

- [ ] Namespace registry (Redis Set)
- [ ] `GET /list-namespaces`
- [ ] `DELETE /delete-namespace/{ns}`
- [ ] `GET /info` — aggregate stats across namespaces

### Phase 5 — Testing + Compatibility

- [ ] Unit tests (filter parser is the big one)
- [ ] Integration tests against Redis Stack in Docker
- [ ] Compatibility test: run `@upstash/vector` SDK test suite against up-vector
- [ ] CI pipeline (GitHub Actions: build → Redis Stack → test)

### Phase 6 — Production Hardening

- [ ] Graceful shutdown
- [ ] Connection retry / reconnect
- [ ] Request timeout configuration
- [ ] Rate limiting (optional)
- [ ] Structured JSON logging
- [ ] Prometheus metrics endpoint (optional)

### Phase 7 — Deferred (only if needed)

- [ ] `/upsert-data` + `/query-data` (server-side embedding via local model)
- [ ] Sparse vector support
- [ ] Hybrid search with fusion algorithms
- [ ] Resumable queries (stateful cursors)
- [ ] Multi-token / multi-index mode (SRH file-mode equivalent)
- [ ] RedisJSON-based metadata indexing (v2 filter upgrade)

---

## Docker Setup

### docker-compose.yml

```yaml
services:
  up-vector:
    build: .
    ports:
      - "${UPVECTOR_PORT:-8080}:8080"
    environment:
      - UPVECTOR_TOKEN=${UPVECTOR_TOKEN}
      - UPVECTOR_REDIS_URL=redis://redis:6379
      - UPVECTOR_PORT=8080
      - UPVECTOR_METRIC=${UPVECTOR_METRIC:-COSINE}
    depends_on:
      redis:
        condition: service_healthy
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/"]
      interval: 10s
      timeout: 5s
      retries: 3

  redis:
    image: redis/redis-stack-server:latest
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5
    restart: unless-stopped

volumes:
  redis-data:
```

### Dockerfile

```dockerfile
FROM oven/bun:alpine AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production=false
COPY . .
RUN bun build src/index.ts --target=bun --outdir=dist --minify

FROM oven/bun:alpine
WORKDIR /app
RUN apk add --no-cache curl
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
EXPOSE 8080
CMD ["bun", "run", "dist/index.js"]
```

---

## Testing Strategy

### 1. Unit Tests (Bun test)

Focus on the filter parser — it's the most complex and error-prone module:

```
filter tokenizer: 30+ test cases (strings, numbers, operators, nested parens)
filter parser: 20+ test cases (simple, compound, nested, edge cases)
filter evaluator: 30+ test cases (every operator, dot notation, arrays)
vector encode/decode: roundtrip fidelity, edge cases (NaN, Infinity, empty)
score normalization: all 3 metrics, boundary values
```

### 2. Integration Tests

Spin up Redis Stack (in Docker or locally), run operations end-to-end:
- Upsert → Query → verify results
- Upsert → Fetch → verify data integrity
- Upsert → Delete → Fetch → verify gone
- Namespace isolation
- Range pagination
- Reset

### 3. Compatibility Tests (the SRH approach)

Clone `upstash/vector-js`, configure it to point at up-vector, run its test suite. This is the ultimate compatibility check — same strategy that makes SRH reliable.

The `@upstash/vector` test suite will need some tests excluded:
- Embedding-related tests (we defer `/upsert-data`, `/query-data`)
- Sparse/hybrid tests (deferred)
- Any tests that rely on Upstash-specific provisioning APIs

### CI Pipeline

```yaml
# .github/workflows/test.yml
on:
  push:
    paths: [src/**, tests/**, package.json, Dockerfile]
  schedule:
    - cron: '0 12 * * *'  # Daily, same as SRH

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      redis:
        image: redis/redis-stack-server:latest
        ports: [6379:6379]
    steps:
      - uses: oven/setup-bun@v2
      - run: bun install
      - run: bun test                    # Unit + integration
      - run: bun test:compat             # @upstash/vector SDK suite
```

---

## Compatibility Notes

### What works identically to Upstash

- All CRUD operations (upsert, fetch, delete, update, range, reset)
- KNN similarity search with all 3 distance metrics
- Score normalization (0-1 range)
- Namespace isolation
- Metadata storage and retrieval
- Bearer token authentication
- JSON request/response envelope format
- The `@upstash/vector` TypeScript SDK (just swap the URL)

### Known differences from Upstash

| Aspect | Upstash | up-vector | Impact |
|--------|---------|-----------|--------|
| ANN algorithm | DiskANN | HNSW (RediSearch) | Slightly different recall characteristics at very high scale. Negligible at <100K vectors. |
| Metadata filtering | Server-side (DiskANN-integrated) | App-level (v1) / RediSearch (v2) | May return slightly different results when filter + topK interact (over-fetch compensates) |
| Embedding endpoints | Built-in models | Not supported (v1) | Client must provide vectors. Use AI SDK for embedding. |
| Sparse/hybrid | Full support | Not supported (v1) | Dense-only. Fine for standard RAG. |
| Resumable queries | Supported | Not supported (v1) | Use range for iteration instead. |
| Index creation | Dashboard/API | Automatic (lazy on first upsert) | No separate provisioning step needed. |
| Multi-index | Per-database | Per-namespace (same Redis) | Equivalent functionality via namespaces. |

---

## Usage (once built)

### Docker Compose

```bash
# Clone and start
git clone https://github.com/Coriou/up-vector.git
cd up-vector
cp .env.example .env
# Edit .env: set UPVECTOR_TOKEN
docker compose up -d
```

### With @upstash/vector SDK

```typescript
import { Index } from "@upstash/vector"

const index = new Index({
  url: "http://localhost:8080",    // up-vector
  token: "your-token-here",
})

// Works exactly like Upstash
await index.upsert([
  { id: "doc-1", vector: embedding, metadata: { title: "Hello" } },
])

const results = await index.query({
  vector: queryEmbedding,
  topK: 5,
  includeMetadata: true,
  filter: "title = 'Hello'",
})
```

### With SRH (side-by-side in Coolify)

Both services can share the same Redis Stack instance, or run independently:

```yaml
# Shared Redis Stack setup
services:
  redis-stack:
    image: redis/redis-stack-server:latest

  srh:
    image: ghcr.io/coriou/srh:latest
    environment:
      SRH_MODE: env
      SRH_TOKEN: ${SRH_TOKEN}
      SRH_CONNECTION_STRING: redis://redis-stack:6379

  up-vector:
    build: ./up-vector
    environment:
      UPVECTOR_TOKEN: ${UPVECTOR_TOKEN}
      UPVECTOR_REDIS_URL: redis://redis-stack:6379
```

---

## References

- [Upstash Vector REST API docs](https://upstash.com/docs/vector/api/endpoints)
- [@upstash/vector SDK source](https://github.com/upstash/vector-js)
- [Redis Stack vector search](https://redis.io/docs/latest/develop/interact/search-and-query/query/vector-search/)
- [RediSearch FT.CREATE](https://redis.io/docs/latest/commands/ft.create/)
- [RediSearch FT.SEARCH](https://redis.io/docs/latest/commands/ft.search/)
- [hiett/serverless-redis-http](https://github.com/hiett/serverless-redis-http)
