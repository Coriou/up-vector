# up-vector

Self-hosted [Upstash Vector](https://upstash.com/docs/vector/overall/getstarted)-compatible HTTP proxy backed by [Redis Stack](https://redis.io/docs/latest/operate/oss_and_stack/install/install-stack/).

Drop-in replacement for `@upstash/vector` — point the SDK at your own server instead of Upstash's cloud. Same spirit as [SRH](https://github.com/hiett/serverless-redis-http), but for vectors.

## Quick Start

```bash
cp .env.example .env
# Edit .env — set UPVECTOR_TOKEN

docker compose up -d
```

The API is now available at `http://localhost:8080`.

## Usage with @upstash/vector

```typescript
import { Index } from "@upstash/vector"

const index = new Index({
  url: "http://localhost:8080",
  token: "your-token-here",
})

await index.upsert([
  { id: "doc-1", vector: [0.1, 0.2, ...], metadata: { title: "Hello" } },
])

const results = await index.query({
  vector: [0.1, 0.2, ...],
  topK: 5,
  includeMetadata: true,
})
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `UPVECTOR_TOKEN` | — | **Required.** Bearer token for API auth |
| `UPVECTOR_REDIS_URL` | `redis://localhost:6379` | Redis Stack connection URL |
| `UPVECTOR_PORT` | `8080` | HTTP listen port |
| `UPVECTOR_METRIC` | `COSINE` | Distance metric: `COSINE`, `EUCLIDEAN`, `DOT_PRODUCT` |
| `UPVECTOR_DIMENSION` | auto | Vector dimension (auto-detected from first upsert) |
| `UPVECTOR_LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error` |

## API Compatibility

Implements the [Upstash Vector REST API](https://upstash.com/docs/vector/api/endpoints):

| Endpoint | Status |
|----------|--------|
| `POST /upsert[/{namespace}]` | Supported |
| `POST /query[/{namespace}]` | Supported |
| `POST /fetch[/{namespace}]` | Supported |
| `POST /delete[/{namespace}]` | Supported |
| `POST /update[/{namespace}]` | Supported |
| `POST /range[/{namespace}]` | Supported |
| `DELETE /reset[/{namespace}]` | Supported |
| `GET /info` | Supported |
| `GET /list-namespaces` | Supported |
| `DELETE /delete-namespace/{ns}` | Supported |
| `POST /upsert-data` | Not yet (requires embedding model) |
| `POST /query-data` | Not yet (requires embedding model) |
| `POST /resumable-query*` | Not yet |

## Development

```bash
bun install
bun dev          # Watch mode
bun test         # Run tests
bun lint         # Biome check
```

## Architecture

See [PLAN.md](./PLAN.md) for full implementation details.

```
@upstash/vector SDK → up-vector (Hono/Bun + Bun.redis) → Redis Stack (RediSearch HNSW)
```

**Stack:** Hono v4 + Bun.redis (native, zero-dep) + Zod validation. No ioredis, no node-redis — Bun's built-in Redis client supports raw `FT.*` commands via `send()` and is 7.9x faster.

## License

MIT
