# up-vector

Self-hosted, Upstash Vector-compatible HTTP proxy backed by Redis Stack.
Drop-in replacement for `@upstash/vector` — point the SDK at your own server instead of Upstash's cloud.

Sibling project to [up-redis](https://github.com/Coriou/up-redis) (same idea, but for vectors).

## Tech Stack

- **Runtime:** Bun 1.2+ (native TypeScript)
- **HTTP:** Hono v4
- **Redis client:** `Bun.redis` (native, zero-dep) — use `.send()` for raw `FT.*` commands
- **Validation:** Zod v3
- **Linting/Format:** Biome v1
- **Testing:** `bun test` (built-in, Jest-compatible)
- **Container:** Docker (oven/bun:alpine) + Redis Stack

**Not a Next.js/Vercel project.** Pure backend service.

## Commands

```bash
bun install              # Install dependencies
bun run dev              # Dev server with --watch
bun run start            # Production start
bun run build            # Bundle to dist/index.js
bun test                 # All tests
bun test tests/unit      # Unit tests only
bun test tests/integration  # Integration tests (needs Redis Stack)
bun run lint             # Biome check
bun run lint:fix         # Biome auto-fix
bun run format           # Biome format
bun run typecheck        # tsc --noEmit
```

### Docker

```bash
docker compose up -d                          # Production (up-vector + Redis Stack)
docker compose -f docker-compose.yml -f docker-compose.dev.yml up  # Dev (watch mode, debug logs)
```

## Code Style

- **Tabs** for indentation (not spaces)
- **Double quotes** for strings
- **No semicolons** (asNeeded)
- **100-char** line width
- Path alias: `@/*` maps to `src/*`
- Biome handles linting + formatting — run `bun run lint:fix` before committing

## Architecture

```
@upstash/vector SDK → HTTP REST → up-vector (Hono/Bun) → Redis protocol → Redis Stack (RediSearch)
```

### Key patterns

- **Response envelope:** `{ "result": <data> }` on success, `{ "error": "<msg>", "status": <code> }` on error
- **Auth:** Bearer token via `Authorization` header, validated against `UPVECTOR_TOKEN` env var
- **Namespaces:** Isolated via Redis key prefixes (`v:{ns}:{id}`) and per-namespace indexes (`idx:{ns}`)
- **Lazy index creation:** `FT.CREATE` runs on first upsert per namespace, not at startup
- **Metadata filtering (v1):** App-level — over-fetch from Redis, filter in JS, trim to topK
- **Vector serialization:** `number[]` (JSON) <-> `Float32Array` buffer (Redis, little-endian)
- **Score normalization:** Raw Redis distances converted to Upstash 0-1 range per metric

### Redis data model

```
Key:    v:{namespace}:{id}          # Hash per vector
Fields: vec (Float32 blob), metadata (JSON string), data (raw string), id (string)

Index:  idx:{namespace}             # RediSearch HNSW index per namespace
Registry: _ns_registry              # Set of known namespace names
```

## Project Structure

```
src/
  index.ts              # Entry point, graceful shutdown
  server.ts             # Hono app + middleware setup
  config.ts             # Env var config (Zod validation)
  redis.ts              # Bun.redis client, health probe
  logger.ts             # Structured JSON/text logger
  metrics.ts            # Prometheus counters + histograms
  shutdown.ts           # Shutdown state (avoids circular dep)
  types.ts              # Shared types (Vector, QueryResult, etc.)
  middleware/
    auth.ts             # Bearer token validation
    error-handler.ts    # Global error -> Upstash error envelope
    logger.ts           # Request logging + request ID
    timeout.ts          # Per-request timeout
  routes/
    health.ts           # GET / + GET /health (with Redis probe)
    metrics.ts          # GET /metrics (Prometheus, opt-in)
    upsert.ts           # POST /upsert[/{ns}]
    query.ts            # POST /query[/{ns}]
    fetch.ts            # POST /fetch[/{ns}]
    delete.ts           # POST|DELETE /delete[/{ns}]
    update.ts           # POST /update[/{ns}]
    range.ts            # POST /range[/{ns}]
    reset.ts            # POST|DELETE /reset[/{ns}]
    info.ts             # GET|POST /info
    namespaces.ts       # list-namespaces, delete-namespace
  translate/
    vectors.ts          # Float32 encode/decode
    scores.ts           # Distance metric normalization
    keys.ts             # Key naming: v:{ns}:{id}, idx:{ns}
    index.ts            # Lazy FT.CREATE management
  filter/
    tokenizer.ts        # Filter string -> tokens
    parser.ts           # Tokens -> AST (recursive descent)
    evaluator.ts        # AST x metadata -> boolean
    types.ts            # AST node types
tests/
  unit/                 # Pure logic tests (filter, vectors, scores, keys)
  integration/          # Against real Redis Stack
  compatibility/        # Run @upstash/vector SDK test suite against up-vector
```

## Environment Variables

All prefixed `UPVECTOR_`:

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `UPVECTOR_TOKEN` | - | **Yes** | Bearer token for API auth |
| `UPVECTOR_REDIS_URL` | `redis://localhost:6379` | No | Redis Stack connection |
| `UPVECTOR_PORT` | `8080` | No | HTTP listen port |
| `UPVECTOR_HOST` | `0.0.0.0` | No | HTTP listen host |
| `UPVECTOR_DIMENSION` | - | No | Fixed vector dim (auto-detected if omitted) |
| `UPVECTOR_METRIC` | `COSINE` | No | `COSINE`, `EUCLIDEAN`, `DOT_PRODUCT` |
| `UPVECTOR_LOG_LEVEL` | `info` | No | `debug`, `info`, `warn`, `error` |
| `UPVECTOR_LOG_FORMAT` | `json` | No | `json` (structured) or `text` (human-readable) |
| `UPVECTOR_SHUTDOWN_TIMEOUT` | `30000` | No | Max ms to wait for request drain on shutdown |
| `UPVECTOR_REQUEST_TIMEOUT` | `30000` | No | Per-request timeout in ms (`0` = disabled) |
| `UPVECTOR_METRICS` | `false` | No | Enable Prometheus `/metrics` endpoint |

## Implementation Status

Phases 1-6 complete. All CRUD + query + filtering + namespaces + production hardening.
198 tests passing (110 unit, 23 integration, 65 SDK compatibility).
Phase 6 added: structured JSON logging, graceful shutdown, health probes, request timeouts, Prometheus metrics.
See `PLAN.md` for the full architecture and phase breakdown.

## Bun.redis Gotchas

- **Never use `redis.hset()` for binary data** — it UTF-8 encodes Buffers, corrupting bytes >= 0x80. Always use `redis.send("HSET", [...])` which preserves raw binary.
- **`redis.hgetall()` returns UTF-8 strings** — binary vector data is corrupted on read. Store a base64 copy (`_vec` field) alongside the raw binary (`vec` field for RediSearch).
- **`redis.scan()` returns cursor as string** — compare with `"0"` not `0`.
- **FT.INFO returns a JS object in RESP3** — not a flat alternating key-value array. Handle both formats.

## Key References

- [Upstash Vector REST API](https://upstash.com/docs/vector/api/endpoints) — the API we're replicating
- [@upstash/vector SDK](https://github.com/upstash/vector-js) — client SDK, also our compatibility test target
- [RediSearch vector search](https://redis.io/docs/latest/develop/interact/search-and-query/query/vector-search/)
- [RediSearch FT.CREATE](https://redis.io/docs/latest/commands/ft.create/) / [FT.SEARCH](https://redis.io/docs/latest/commands/ft.search/)
- [up-redis](https://github.com/Coriou/up-redis) — sibling project (same pattern, but for standard Redis commands)
