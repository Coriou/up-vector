# Maintenance: State-of-the-Art Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring up-vector back to a known-good, production-maintainable baseline — safe dep patches, full green suite with recorded counts, local SDK/docs surface audit, doc truth, CI review, and four documented LOW hardening items — without product expansion or deferred architecture work.

**Architecture:** Maintenance pass only (PR #2 style). No Redis data-model or route redesign. Optional metrics token is config-gated; embedding errors are sanitized at the provider boundary; filter `IN()` gains a hard value-list cap; `/random` honors include flags with vector-include default true for backward compatibility. Authority for dense surface remains local `@upstash/vector` + existing routes.

**Tech Stack:** Bun 1.3+, Hono v4, Zod v4, Biome v2, `bun test`, Redis Stack (integration/compat), `@upstash/vector@1.2.3` (pinned; weekly job uses `@latest`).

**Spec:** [docs/superpowers/specs/2026-07-17-maintenance-state-of-the-art-design.md](../specs/2026-07-17-maintenance-state-of-the-art-design.md)

## Global Constraints

- Drop-in dense-only replacement for `@upstash/vector`; pure Bun/Hono backend (not Next.js/Vercel)
- Response envelope `{ result }` / `{ error, status }`; Bearer `UPVECTOR_TOKEN`
- Metadata filtering v1 stays app-level over-fetch + JS filter; lazy `FT.CREATE`
- Binary Redis: `redis.send` for HSET; `_vec` base64 mirror; SCAN cursor string `"0"`
- Style: tabs, double quotes, no semicolons, 100-char width; Biome; `@/*` → `src/*`
- Rate limiting = reverse proxy only
- Sparse/hybrid deferred; dense reject sparse; resumable = 501; no Upstash-hosted embedding catalog
- Session scope: maintenance only — no `/range` redesign, no filter pushdown, no sparse/hybrid, no resumable, no live Upstash Cloud diff
- Major deps stay put: TypeScript `^6.0.3` (no 7.x), Zod stay unless patch-only and green
- Bun CI pin remains `1.3.6` unless install/runtime forces a verified change

---

## File Structure (create / modify)

| Path | Responsibility |
|------|----------------|
| `package.json` / `bun.lock` | Safe pin bumps: `hono` → 4.12.30, `@biomejs/biome` → 2.5.4; reconfirm `@upstash/vector@1.2.3` |
| `src/config.ts` | Add optional `UPVECTOR_METRICS_TOKEN` → `config.metricsToken` |
| `src/embedding.ts` | Sanitize client-facing provider errors; log full provider detail server-side |
| `src/filter/parser.ts` | `MAX_IN_LIST_VALUES = 256`; reject oversized `IN()` lists with `ValidationError` |
| `src/routes/random.ts` | Parse/honor `includeMetadata`, `includeVectors` (default true), `includeData` |
| `src/routes/metrics.ts` | Optional Bearer check when `config.metricsToken` is set |
| `src/server.ts` | No structural change required unless metrics wiring needs a comment only |
| `tests/unit/embedding.test.ts` | Assert sensitive upstream text not in client error message |
| `tests/unit/filter.test.ts` | At-cap / over-cap `IN()` list tests |
| `tests/unit/metrics-auth.test.ts` | **Create** — optional metrics token unit tests via pure helper + mini app |
| `tests/integration/random.test.ts` | Include-flag combinations for `/random` |
| `README.md` | Test counts, env table (`UPVECTOR_METRICS_TOKEN`), metrics ops note |
| `Claude.md` | Status counts + env table row if token added |
| `PLAN.md` | Phase 7: mark upsert-data/query-data done; leave true deferred items |
| `.github/workflows/test.yml` / `compat.yml` | Review only; fix only if broken/drifted |
| `scripts/test-all.sh` | Review only; fix only if broken |

**Do not create/modify for this pass:** filter pushdown, range pagination redesign, sparse/hybrid routes, resumable beyond existing 501, multi-token mode, Dockerfile Bun major pin (optional note only).

---

### Task 1: Baseline verification (green or catalog failures)

**Files:**
- Read only: `package.json`, `bun.lock`, `scripts/test-all.sh`, `.github/workflows/test.yml`
- No production code changes unless the suite is already red for a real bug (then fold fix into Task 7)

**Interfaces:**
- Consumes: local Bun, Docker Redis Stack (via `scripts/test-all.sh` or compose)
- Produces: recorded counts `unit / integration / compatibility / total` for later docs; known failure list if any

- [ ] **Step 1: Confirm tooling**

```bash
bun --version
# Expected: 1.3.x (local may differ slightly from CI 1.3.6; note the version)
docker --version
# Redis Stack available via docker compose (scripts/test-all.sh starts redis service)
```

- [ ] **Step 2: Install from lockfile**

```bash
cd /Users/ben/Projects/up-vector
bun install
```

Expected: lockfile respected; no surprise major bumps.

- [ ] **Step 3: Typecheck + lint + unit (no Redis required)**

```bash
bun run typecheck
bun run lint
UPVECTOR_TOKEN=test bun test tests/unit
```

Expected: all pass. Capture unit pass count from the summary line (e.g. `XXX pass`).

- [ ] **Step 4: Full gate against fresh Redis + up-vector**

Prefer the project script (starts Redis + server + free ports + fake embedding env):

```bash
./scripts/test-all.sh
```

If you already have Redis Stack on `6379` and prefer manual:

```bash
export UPVECTOR_TOKEN=test-token-123
export UPVECTOR_REDIS_URL=redis://localhost:6379
export UPVECTOR_EMBEDDING_PROVIDER=fake
export UPVECTOR_EMBEDDING_MODEL=fake-embedding
export UPVECTOR_EMBEDDING_DIMENSION=8
export UPVECTOR_PORT=8080
# start server in another terminal: bun run src/index.ts
bun test tests/integration
bun test tests/compatibility
```

**Isolation gotchas (do not “fix” incorrectly):**
- Namespace rename isolation can fail on dirty Redis leftovers; use fresh Redis.
- Never `FLUSHALL` under a long-lived up-vector process without restart (`dimensionMap` / `knownIndexes` go stale).
- Do not mass-refactor `awaitIndexed` sleeps unless a real flake appears.

- [ ] **Step 5: Record counts**

Write them into the PR notes / commit message later:

```text
Unit: <N>
Integration: <N>
Compatibility: <N>
Total: <N>
@upstash/vector pin: $(node -p "require('./node_modules/@upstash/vector/package.json').version")
npm latest (informational): npm view @upstash/vector version
```

If anything fails for a **real** bug (crash, wrong envelope, score mapping, data corruption): catalog it for Task 7; do not redesign deferred architecture items.

- [ ] **Step 6: Commit only if you added a notes file (otherwise skip commit)**

Baseline is usually uncommitted observation. If you create a temporary notes file, do not leave it in the tree — keep counts for Task 8 docs.

---

### Task 2: Safe dependency bumps

**Files:**
- Modify: `package.json`, `bun.lock`
- Verify: full suite from Task 1

**Interfaces:**
- Consumes: baseline green from Task 1
- Produces: lockfile with `hono@4.12.30`, `@biomejs/biome@2.5.4`, `@upstash/vector` still latest pin (1.2.3 unless npm moved)

- [ ] **Step 1: Confirm current lock pins and npm targets**

```bash
grep -E 'hono@|@biomejs/biome@|@upstash/vector@' bun.lock | head -20
npm view hono version
npm view @biomejs/biome version
npm view @upstash/vector version
```

Decision Pack targets (as of 2026-07-17): `hono` 4.12.30, `@biomejs/biome` 2.5.4, `@upstash/vector` 1.2.3 (latest). If npm latest for hono/biome is newer patch than those targets but still within the existing caret ranges, prefer the Decision Pack versions unless already past them; do not jump minor/major.

- [ ] **Step 2: Bump packages**

```bash
bun add hono@4.12.30
bun add -d @biomejs/biome@2.5.4
# Only if npm latest > 1.2.3 and still drop-in:
# bun add -d @upstash/vector@latest
```

Leave `zod` and `typescript` alone unless a patch is clearly available and you re-green fully. Do **not** upgrade TypeScript to 7.x.

- [ ] **Step 3: Re-green**

```bash
bun run typecheck
bun run lint
UPVECTOR_TOKEN=test bun test tests/unit
./scripts/test-all.sh
```

Expected: all green. If a bump breaks the bar, revert that package only:

```bash
bun add hono@4.12.27   # example revert
# or
bun add -d @biomejs/biome@2.5.1
```

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lock
git commit -m "$(cat <<'EOF'
chore: bump hono 4.12.30 and biome 2.5.4

Safe patch bumps within existing caret ranges; re-lock and re-green the full suite.
EOF
)"
```

---

### Task 3: Local SDK / API surface audit (read-only + PR notes)

**Files:**
- Read: `node_modules/@upstash/vector/dist/vector-3yYKIF78.d.ts` (or current dist types), `src/routes/*`, `src/routes/unsupported.ts`, `tests/compatibility/*`, `.github/workflows/compat.yml`, Upstash REST docs (browser)
- Modify only if a **dense** gap requires a small reject/support fix (document in Task 7); prefer documentation over invention

**Interfaces:**
- Consumes: `@upstash/vector@1.2.3` `_ENDPOINTS` inventory
- Produces: PR-body audit notes (no unexpected dense gaps, or gap fixed/rejected/documented)

- [ ] **Step 1: Confirm SDK pin vs npm latest**

```bash
node -p "require('./node_modules/@upstash/vector/package.json').version"
npm view @upstash/vector version
```

Expected today: both `1.2.3`. If npm moved, note it; pin update only if drop-in and green (Task 2).

- [ ] **Step 2: Inventory SDK endpoints vs up-vector**

From published types (`_ENDPOINTS` in `@upstash/vector`):

| SDK / REST surface | up-vector stance | Verify path |
|--------------------|------------------|-------------|
| upsert / query / fetch / delete / update / range / reset / info | Supported | `src/routes/{upsert,query,fetch,delete,update,range,reset,info}.ts` |
| upsert-data / query-data | Supported when embedding configured; 400 when disabled | `src/routes/data.ts`, `src/embedding.ts` |
| list-namespaces / delete-namespace (+ rename) | Supported | `src/routes/namespaces.ts` |
| resumable-query* | Explicit 501 | `src/routes/unsupported.ts` |
| sparseVector / fusion / queryMode / weightingStrategy on dense paths | Rejected | Zod `z.never().optional()` in upsert/query/update/data |
| Hosted model catalog / provisioning | Not implemented | Do not invent |

Confirm with greps:

```bash
grep -n "sparseVector\|z.never" src/routes/*.ts
grep -n "resumable" src/routes/unsupported.ts
ls tests/compatibility/
```

- [ ] **Step 3: Spot-check Upstash REST docs for new dense endpoints/fields**

Open [Upstash Vector REST API](https://upstash.com/docs/vector/api/endpoints). Look only for **new dense** endpoints or request fields dense clients might send.

- If required for drop-in dense SDK use and small/testable: implement in Task 7 with tests.
- Else: reject with clear validation/501 and note for README table in Task 8.
- Out of parity claims: score numeric identity with cloud, HNSW vs DiskANN, selective filter under-topK, `/range` memory.

- [ ] **Step 4: Walk compat suite relevance**

```bash
ls tests/compatibility/
# basic, data, delete, fetch, info, namespaces, query, range, reset, update, upsert + setup
```

Drop/rewrite only tests that assert obsolete behavior. Add a thin case only if Step 2–3 finds a dense gap existing tests miss. Keep suite lean — no sparse/hybrid/resumable expansion.

- [ ] **Step 5: Review weekly `compat.yml`**

Check `.github/workflows/compat.yml` against `test.yml`:
- Bun pin `1.3.6`
- Embedding fake env: `UPVECTOR_EMBEDDING_PROVIDER=fake`, model, dimension `8`
- `@upstash/vector@latest` install step
- Issue labels `sdk-compat,automated` + exact-title dedup
- Log dump on failure

Fix only if broken or drifted. If no changes:

```bash
# no commit for this task
```

If you fix workflow drift:

```bash
git add .github/workflows/compat.yml .github/workflows/test.yml
git commit -m "$(cat <<'EOF'
ci: align weekly compat workflow with test embedding env

Keep fake provider env and Bun pin consistent so data-compat tests do not false-fail.
EOF
)"
```

- [ ] **Step 6: Capture audit notes for PR body**

Paste into the eventual PR description:

```markdown
## SDK surface audit (@upstash/vector@1.2.3, local only)
- _ENDPOINTS: all dense paths mapped to supported / 501 / validation reject
- No new dense REST fields requiring implementation (or: <list>)
- Sparse/hybrid still rejected; resumable still 501
- Weekly compat.yml: reviewed <OK | fixed>
```

---

### Task 4: LOW hardening — embedding upstream error sanitization (4.2)

**Files:**
- Modify: `src/embedding.ts` (error throw path ~lines 124–128; `readProviderError` stays for logging)
- Test: `tests/unit/embedding.test.ts`

**Interfaces:**
- Consumes: `readProviderError(response): Promise<string>`, `EmbeddingProviderError`, `log` from `src/logger.ts`
- Produces: client messages like `Embedding provider failed with HTTP 429` with **no** raw upstream body; server logs include `providerMessage`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/embedding.test.ts` inside `describe("OpenAICompatibleEmbeddingProvider", …)`:

```typescript
test("does not echo sensitive upstream error text to clients", async () => {
	const sensitive = "billing: account sk-secret-abc model text-embedding-3-large quota"
	const provider = new OpenAICompatibleEmbeddingProvider({
		apiKey: "test-key",
		retries: 0,
		fetchFn: async () =>
			Response.json({ error: { message: sensitive } }, { status: 429 }),
	})

	try {
		await provider.embedMany(["hello"])
		throw new Error("expected provider to fail")
	} catch (err) {
		expect(err).toBeInstanceOf(EmbeddingProviderError)
		expect((err as EmbeddingProviderError).status).toBe(502)
		const message = (err as Error).message
		expect(message).toContain("HTTP 429")
		expect(message).not.toContain("sk-secret-abc")
		expect(message).not.toContain("billing")
		expect(message).not.toContain(sensitive)
		// Generic class message only — no ": <upstream>" suffix
		expect(message).toBe("Embedding provider failed with HTTP 429")
	}
})
```

Also update the existing test `"maps provider HTTP errors to EmbeddingProviderError"` which currently only asserts `toContain("HTTP 401")` — after the change it must still pass; tighten if it expected the old `: bad key` suffix:

```typescript
// In the existing test body, keep:
expect((err as Error).message).toContain("HTTP 401")
// And add:
expect((err as Error).message).not.toContain("bad key")
expect((err as Error).message).toBe("Embedding provider failed with HTTP 401")
```

- [ ] **Step 2: Run test to verify it fails**

```bash
UPVECTOR_TOKEN=test bun test tests/unit/embedding.test.ts
```

Expected: FAIL — current message is `Embedding provider failed with HTTP 429: billing: …`.

- [ ] **Step 3: Implement sanitization**

In `src/embedding.ts`:
1. Import logger: `import { log } from "./logger"`
2. Replace the non-OK response throw block:

```typescript
const message = await readProviderError(response)
if (message) {
	log.warn("embedding provider error", {
		status: response.status,
		providerMessage: message,
	})
}
throw new EmbeddingProviderError(
	`Embedding provider failed with HTTP ${response.status}`,
	502,
)
```

Do **not** change timeout (`504`) or malformed (`502`) generic strings that already omit upstream bodies. Preserve retry behavior for 429/5xx via `isRetryableStatus`.

- [ ] **Step 4: Run tests to verify pass**

```bash
UPVECTOR_TOKEN=test bun test tests/unit/embedding.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/embedding.ts tests/unit/embedding.test.ts
git commit -m "$(cat <<'EOF'
fix: stop echoing embedding provider error bodies to clients

Log full upstream detail server-side; return only a generic HTTP-class message.
EOF
)"
```

---

### Task 5: LOW hardening — cap filter `IN()` lists (4.3)

**Files:**
- Modify: `src/filter/parser.ts` (`parseValueList`, add `MAX_IN_LIST_VALUES`)
- Test: `tests/unit/filter.test.ts`

**Interfaces:**
- Consumes: `ValidationError` from `src/errors.ts`
- Produces: `MAX_IN_LIST_VALUES = 256`; over-cap throws `ValidationError` with message `IN list must not exceed 256 values`

- [ ] **Step 1: Write the failing tests**

In `tests/unit/filter.test.ts`, near other parser tests for `IN` (around the existing `"IN list"` parse cases ~line 180), add:

```typescript
test("rejects IN lists larger than 256 values", () => {
	const values = Array.from({ length: 257 }, (_, i) => `'v${i}'`).join(", ")
	expect(() => parse(tokenize(`tag IN (${values})`))).toThrow(ValidationError)
	expect(() => parse(tokenize(`tag IN (${values})`))).toThrow(
		"IN list must not exceed 256 values",
	)
})

test("accepts IN lists with exactly 256 values", () => {
	const values = Array.from({ length: 256 }, (_, i) => `'v${i}'`).join(", ")
	const ast = parse(tokenize(`tag IN (${values})`))
	expect(ast.type).toBe("in")
	if (ast.type === "in") {
		expect(ast.values.length).toBe(256)
	}
})

test("rejects NOT IN lists larger than 256 values", () => {
	const values = Array.from({ length: 257 }, (_, i) => i).join(", ")
	expect(() => parse(tokenize(`n NOT IN (${values})`))).toThrow(
		"IN list must not exceed 256 values",
	)
})
```

- [ ] **Step 2: Run tests to verify fail**

```bash
UPVECTOR_TOKEN=test bun test tests/unit/filter.test.ts
```

Expected: FAIL — 257-value list currently parses.

- [ ] **Step 3: Implement cap in parser**

In `src/filter/parser.ts`, next to `MAX_DEPTH`:

```typescript
const MAX_DEPTH = 100
const MAX_IN_LIST_VALUES = 256
```

Update `parseValueList`:

```typescript
function parseValueList(): Value[] {
	expect("LPAREN")
	const values: Value[] = [parseValue()]
	while (peek().type === "COMMA") {
		advance() // skip comma
		values.push(parseValue())
		if (values.length > MAX_IN_LIST_VALUES) {
			throw new ValidationError(
				`IN list must not exceed ${MAX_IN_LIST_VALUES} values`,
			)
		}
	}
	expect("RPAREN")
	return values
}
```

Filter string length cap (`MAX_FILTER_LENGTH = 8192` in tokenizer) stays unchanged. Global error handler already maps `ValidationError` → 400 envelope.

- [ ] **Step 4: Run tests to verify pass**

```bash
UPVECTOR_TOKEN=test bun test tests/unit/filter.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/filter/parser.ts tests/unit/filter.test.ts
git commit -m "$(cat <<'EOF'
fix: cap filter IN() lists at 256 values

Prevent unbounded parse/evaluate cost while keeping the 8192-char filter string limit.
EOF
)"
```

---

### Task 6: LOW hardening — `/random` include flags (4.4)

**Files:**
- Modify: `src/routes/random.ts`
- Test: `tests/integration/random.test.ts`

**Interfaces:**
- Consumes: Redis hash fields `_vec`, `metadata`, `data`; `decodeVectorBase64`; `Vector` type
- Produces: flags `includeMetadata` (default false), `includeVectors` (default **true**), `includeData` (default false); omit fields when false; still return `id`; empty namespace → `{ result: null }`

Defaults intentionally keep current response shape (`id` + `vector`) for callers that only read `result.vector`. Align with fetch/range field selection pattern in `src/routes/fetch.ts` `buildVector`.

- [ ] **Step 1: Extend integration fixtures and write failing tests**

Replace/extend `tests/integration/random.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { api, resetAll } from "./setup"

describe("random vector", () => {
	beforeAll(async () => {
		await resetAll()
		await api("POST", "/upsert", [
			{
				id: "rnd-a",
				vector: [1, 0, 0],
				metadata: { color: "red" },
				data: "alpha",
			},
			{
				id: "rnd-b",
				vector: [0, 1, 0],
				metadata: { color: "blue" },
				data: "beta",
			},
		])
		await api("POST", "/upsert/rnd-ns", {
			id: "rnd-ns-a",
			vector: [0, 0, 1],
			metadata: { ns: true },
			data: "ns-data",
		})
	})

	afterAll(resetAll)

	test("GET /random returns a dense vector from the default namespace", async () => {
		const { data } = await api("GET", "/random")
		const result = (data as { result: { id: string; vector: number[] } }).result
		expect(["rnd-a", "rnd-b"]).toContain(result.id)
		expect(result.vector.length).toBe(3)
	})

	test("POST /random works for SDK-style clients and namespaces", async () => {
		const { data } = await api("POST", "/random/rnd-ns")
		const result = (data as { result: { id: string; vector: number[] } }).result
		expect(result.id).toBe("rnd-ns-a")
		expect(result.vector).toEqual([0, 0, 1])
	})

	test("empty namespace returns null", async () => {
		const { data } = await api("GET", "/random/empty-random-ns")
		expect((data as { result: null }).result).toBeNull()
	})

	test("defaults include vectors and omit metadata/data", async () => {
		const { data } = await api("GET", "/random")
		const result = (data as { result: Record<string, unknown> }).result
		expect(result.vector).toBeDefined()
		expect(result.metadata).toBeUndefined()
		expect(result.data).toBeUndefined()
	})

	test("GET honors includeMetadata and includeData query flags", async () => {
		const { data } = await api(
			"GET",
			"/random?includeMetadata=true&includeData=true",
		)
		const result = (data as {
			result: { id: string; metadata?: { color: string }; data?: string }
		}).result
		expect(result.metadata?.color).toBeDefined()
		expect(result.data).toBeDefined()
	})

	test("POST can omit vectors when includeVectors is false", async () => {
		const { data } = await api("POST", "/random/rnd-ns", {
			includeVectors: false,
			includeMetadata: true,
			includeData: true,
		})
		const result = (data as {
			result: {
				id: string
				vector?: number[]
				metadata?: { ns: boolean }
				data?: string
			}
		}).result
		expect(result.id).toBe("rnd-ns-a")
		expect(result.vector).toBeUndefined()
		expect(result.metadata).toEqual({ ns: true })
		expect(result.data).toBe("ns-data")
	})

	test("POST with empty body keeps vector default", async () => {
		const res = await fetch(
			`${process.env.UPVECTOR_TEST_URL ?? "http://localhost:8080"}/random/rnd-ns`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${process.env.UPVECTOR_TOKEN ?? "test-token-123"}`,
					"Content-Type": "application/json",
				},
				body: "",
			},
		)
		const data = (await res.json()) as { result: { id: string; vector?: number[] } }
		expect(res.status).toBe(200)
		expect(data.result.id).toBe("rnd-ns-a")
		expect(data.result.vector).toEqual([0, 0, 1])
	})
})
```

Note: `api()` from setup only sends a body when `body` is truthy; for empty-body POST use raw `fetch` as above.

- [ ] **Step 2: Run integration tests to verify fail**

```bash
# with up-vector + Redis running (or via scripts/test-all.sh after implement)
UPVECTOR_TOKEN=test-token-123 bun test tests/integration/random.test.ts
```

Expected: FAIL on metadata/data/includeVectors cases (flags ignored today).

- [ ] **Step 3: Implement include flags in `src/routes/random.ts`**

Replace the file content with:

```typescript
import { type Context, Hono } from "hono"
import { z } from "zod"
import { getClient } from "../redis"
import { parseVectorKey, validateNamespace, vectorPrefix } from "../translate/keys"
import { decodeVectorBase64 } from "../translate/vectors"
import type { Vector } from "../types"

const MAX_SCAN_ITERATIONS = 10_000

const RandomBody = z.object({
	includeMetadata: z.boolean().default(false),
	includeVectors: z.boolean().default(true),
	includeData: z.boolean().default(false),
})

export const randomRoutes = new Hono()

function parseBoolParam(raw: string | undefined, defaultValue: boolean): boolean {
	if (raw === undefined) return defaultValue
	if (raw === "true" || raw === "1") return true
	if (raw === "false" || raw === "0") return false
	return defaultValue
}

async function parseRandomOptions(c: Context): Promise<z.infer<typeof RandomBody>> {
	if (c.req.method === "GET") {
		return {
			includeMetadata: parseBoolParam(c.req.query("includeMetadata"), false),
			includeVectors: parseBoolParam(c.req.query("includeVectors"), true),
			includeData: parseBoolParam(c.req.query("includeData"), false),
		}
	}

	// POST: empty body → defaults; non-empty invalid JSON → SyntaxError → 400 via errorHandler
	const text = await c.req.text()
	if (!text.trim()) {
		return RandomBody.parse({})
	}
	return RandomBody.parse(JSON.parse(text))
}

function buildRandomVector(
	hash: Record<string, string>,
	id: string,
	opts: z.infer<typeof RandomBody>,
): Vector {
	const vec: Vector = { id }
	if (opts.includeVectors && hash._vec) {
		vec.vector = decodeVectorBase64(hash._vec)
	}
	if (opts.includeMetadata && hash.metadata) {
		try {
			vec.metadata = JSON.parse(hash.metadata)
		} catch {
			// Malformed metadata JSON — skip
		}
	}
	if (opts.includeData && hash.data !== undefined) {
		vec.data = hash.data
	}
	return vec
}

const handleRandom = async (c: Context) => {
	const opts = await parseRandomOptions(c)
	const ns = c.req.param("namespace") ?? ""
	validateNamespace(ns)
	const redis = getClient()
	const pattern = `${vectorPrefix(ns)}*`

	let cursor = "0"
	let iterations = 0
	let seen = 0
	let selectedKey: string | undefined

	// Reservoir sample over the namespace so every matching key has equal
	// probability without materializing the full namespace in memory.
	do {
		if (++iterations > MAX_SCAN_ITERATIONS) break
		const result = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100)
		const [next, keys] = result as unknown as [string, string[]]

		for (const key of keys) {
			seen++
			if (Math.floor(Math.random() * seen) === 0) {
				selectedKey = key
			}
		}

		cursor = next
	} while (cursor !== "0")

	if (!selectedKey) {
		return c.json({ result: null })
	}

	const hash = await redis.hgetall(selectedKey)
	if (!hash || Object.keys(hash).length === 0) {
		return c.json({ result: null })
	}

	// Need at least one stored field; empty hash already handled. If vectors
	// are omitted by flag, still return id (+ optional metadata/data).
	if (!hash._vec && !hash.metadata && hash.data === undefined) {
		return c.json({ result: null })
	}

	const parsedKey = parseVectorKey(selectedKey)
	const id = parsedKey?.id ?? hash.id ?? selectedKey
	return c.json({ result: buildRandomVector(hash, id, opts) })
}

randomRoutes.get("/random/:namespace?", handleRandom)
randomRoutes.post("/random/:namespace?", handleRandom)
```

- [ ] **Step 4: Run integration + unit smoke**

```bash
UPVECTOR_TOKEN=test-token-123 bun test tests/integration/random.test.ts
UPVECTOR_TOKEN=test bun test tests/unit
```

Expected: PASS for random flags; full unit still green.

- [ ] **Step 5: Commit**

```bash
git add src/routes/random.ts tests/integration/random.test.ts
git commit -m "$(cat <<'EOF'
feat: honor include flags on /random

Defaults keep includeVectors=true so existing clients still receive result.vector.
EOF
)"
```

---

### Task 7: LOW hardening — optional `/metrics` token (4.1)

**Files:**
- Modify: `src/config.ts`, `src/routes/metrics.ts`
- Create: `tests/unit/metrics-auth.test.ts`
- Optionally touch: `src/server.ts` (comment only if useful)

**Interfaces:**
- Consumes: `UPVECTOR_METRICS` (existing), new optional `UPVECTOR_METRICS_TOKEN`
- Produces: `config.metricsToken: string | undefined`; when set, `GET /metrics` requires `Authorization: Bearer <token>`; when unset, unauthenticated (current Prometheus-friendly default)
- Auth failure envelope: `{ error, status }` via `HTTPException` + global error handler (same as other auth failures)

Design choice locked by spec: do **not** always require `UPVECTOR_TOKEN` for metrics (breaks common Prometheus scrapers). Optional dedicated token is the compromise.

- [ ] **Step 1: Write pure helper + unit tests first**

Create `tests/unit/metrics-auth.test.ts`:

```typescript
import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { errorHandler } from "../../src/middleware/error-handler"
import {
	assertMetricsAuthorized,
	metricsAuthorizationOk,
} from "../../src/routes/metrics"

describe("metricsAuthorizationOk", () => {
	test("allows all requests when token is unset", () => {
		expect(metricsAuthorizationOk(undefined, undefined)).toBe(true)
		expect(metricsAuthorizationOk("Bearer anything", undefined)).toBe(true)
		expect(metricsAuthorizationOk(undefined, "")).toBe(true)
	})

	test("requires exact Bearer token when configured", () => {
		expect(metricsAuthorizationOk("Bearer scrape-secret", "scrape-secret")).toBe(
			true,
		)
		expect(metricsAuthorizationOk("Bearer wrong", "scrape-secret")).toBe(false)
		expect(metricsAuthorizationOk(undefined, "scrape-secret")).toBe(false)
		expect(metricsAuthorizationOk("scrape-secret", "scrape-secret")).toBe(false)
	})
})

describe("assertMetricsAuthorized + /metrics handler shape", () => {
	test("returns 401 envelope when token required and missing", async () => {
		const app = new Hono()
		app.onError(errorHandler)
		app.get("/metrics", (c) => {
			assertMetricsAuthorized(c.req.header("Authorization"), "scrape-secret")
			return c.text("ok")
		})
		const res = await app.request("/metrics")
		expect(res.status).toBe(401)
		expect(await res.json()).toEqual({ error: "Unauthorized", status: 401 })
	})

	test("returns metrics body when Bearer matches", async () => {
		const app = new Hono()
		app.onError(errorHandler)
		app.get("/metrics", (c) => {
			assertMetricsAuthorized(c.req.header("Authorization"), "scrape-secret")
			return c.text("# HELP demo\n", 200, {
				"Content-Type": "text/plain; version=0.0.4; charset=utf-8",
			})
		})
		const res = await app.request("/metrics", {
			headers: { Authorization: "Bearer scrape-secret" },
		})
		expect(res.status).toBe(200)
		expect(await res.text()).toContain("# HELP")
	})
})
```

- [ ] **Step 2: Run tests to verify fail**

```bash
UPVECTOR_TOKEN=test bun test tests/unit/metrics-auth.test.ts
```

Expected: FAIL — exports missing.

- [ ] **Step 3: Implement config + metrics helpers**

In `src/config.ts`, add to the Zod object (after `UPVECTOR_METRICS`):

```typescript
UPVECTOR_METRICS: z.enum(["true", "false"]).default("false"),
// Optional scrape token for GET /metrics. When set, Prometheus (or any scraper)
// must send Authorization: Bearer <token>. When unset, /metrics stays open
// (only reachable if UPVECTOR_METRICS=true).
UPVECTOR_METRICS_TOKEN: z.string().min(1).optional(),
```

Export on `config`:

```typescript
metricsEnabled: parsed.UPVECTOR_METRICS === "true",
metricsToken: parsed.UPVECTOR_METRICS_TOKEN as string | undefined,
```

Replace `src/routes/metrics.ts` with:

```typescript
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { config } from "../config"
import { formatMetrics } from "../metrics"

export function metricsAuthorizationOk(
	authorizationHeader: string | undefined,
	token: string | undefined,
): boolean {
	if (!token) return true
	return authorizationHeader === `Bearer ${token}`
}

export function assertMetricsAuthorized(
	authorizationHeader: string | undefined,
	token: string | undefined,
): void {
	if (!metricsAuthorizationOk(authorizationHeader, token)) {
		throw new HTTPException(401, { message: "Unauthorized" })
	}
}

export const metricsRoutes = new Hono()

metricsRoutes.get("/metrics", (c) => {
	assertMetricsAuthorized(c.req.header("Authorization"), config.metricsToken)
	return c.text(formatMetrics(), 200, {
		"Content-Type": "text/plain; version=0.0.4; charset=utf-8",
	})
})
```

`src/server.ts` already mounts metrics **before** global auth when `config.metricsEnabled` — leave that order; the route self-guards when `metricsToken` is set.

Optional comment above the metrics mount in `server.ts`:

```typescript
// Metrics endpoint (before app auth). Unauthenticated unless UPVECTOR_METRICS_TOKEN is set.
```

- [ ] **Step 4: Run unit tests**

```bash
UPVECTOR_TOKEN=test bun test tests/unit/metrics-auth.test.ts
UPVECTOR_TOKEN=test bun test tests/unit
```

Expected: PASS.

Integration note: the default integration process usually has `UPVECTOR_METRICS=false`, so end-to-end scrape auth is covered by the unit mini-app above. Do not force metrics on in `scripts/test-all.sh` unless you also add a dedicated integration job — out of scope unless you want an optional local manual check:

```bash
UPVECTOR_METRICS=true UPVECTOR_METRICS_TOKEN=scrape bun run src/index.ts
curl -i http://localhost:8080/metrics            # 401
curl -i -H "Authorization: Bearer scrape" http://localhost:8080/metrics  # 200
```

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/routes/metrics.ts src/server.ts tests/unit/metrics-auth.test.ts
git commit -m "$(cat <<'EOF'
feat: optional bearer token for /metrics scrapes

Default remains open when UPVECTOR_METRICS=true and no token is set; set
UPVECTOR_METRICS_TOKEN to require Authorization on Prometheus scrapes.
EOF
)"
```

---

### Task 8: Docs, PLAN Phase 7, final suite + counts

**Files:**
- Modify: `README.md`, `Claude.md`, `PLAN.md`
- Review only: `docs/architecture/sparse-hybrid.md` (optional one-line “still deferred as of 2026-07-17” if useful; not required)
- Review only: `.github/workflows/*`, `scripts/test-all.sh` (fix only if broken)

**Interfaces:**
- Consumes: final test counts from a green full suite after Tasks 2–7
- Produces: truthful counts, env tables including `UPVECTOR_METRICS_TOKEN`, Phase 7 marked done for provider-backed data endpoints

- [ ] **Step 1: Final full suite**

```bash
./scripts/test-all.sh
```

Record:

```text
Unit: <U>
Integration: <I>
Compatibility: <C>
Total: <T = U+I+C>
```

Also reconfirm:

```bash
node -p "require('./node_modules/@upstash/vector/package.json').version"
bun run typecheck && bun run lint
```

- [ ] **Step 2: Update README counts and metrics docs**

In `README.md`:

1. Replace stale **346** (appears in API Compatibility intro and Testing section) with `<T>`.
2. Update the tier table unit/integration/compat counts to `<U>` / `<I>` / `<C>` (keep 74 only if still true).
3. Add env row after `UPVECTOR_METRICS`:

```markdown
| `UPVECTOR_METRICS_TOKEN` | — | Optional. When set (and metrics enabled), `GET /metrics` requires `Authorization: Bearer <token>`. When unset, `/metrics` is unauthenticated (Prometheus-friendly). Prefer network policy or this token if the port is public. |
```

4. Expand the Prometheus section (~line 247) to document the optional token and exposure risk:

```markdown
**Prometheus metrics** — enable with `UPVECTOR_METRICS=true` (disabled by default):

```bash
# Unauthenticated when UPVECTOR_METRICS_TOKEN is unset
curl http://localhost:8080/metrics

# When UPVECTOR_METRICS_TOKEN=scrape-secret
curl -H "Authorization: Bearer scrape-secret" http://localhost:8080/metrics
```

Enabling metrics without a scrape network or token exposes request-volume counters if the listen port is public.
```

5. Keep the compatibility table dense-only + 501 resumable statements.

- [ ] **Step 3: Update `Claude.md`**

In Implementation Status, replace the hard-coded **360** (or whatever is listed) with the new total and restate:

```markdown
Phases 1-6 complete. Dense-vector CRUD + query + filtering + namespaces + production hardening + provider-backed `/upsert-data`/`/query-data`.
<T> tests passing (<U> unit, <I> integration, <C> SDK compatibility).
```

Add `UPVECTOR_METRICS_TOKEN` to the env table (optional, No, purpose as above).

- [ ] **Step 4: Fix `PLAN.md` Phase 7**

Replace the deferred Phase 7 checklist (currently still listing upsert-data as todo) with truth:

```markdown
### Phase 7 — Deferred (only if needed)

- [x] `/upsert-data` + `/query-data` (provider-backed: `openai` / `fake` / `disabled`; not Upstash-hosted model catalog)
- [ ] Sparse vector support
- [ ] Hybrid search with fusion algorithms
- [ ] Resumable queries (stateful cursors)
- [ ] Multi-token / multi-index mode (up-redis file-mode equivalent)
- [ ] RedisJSON-based metadata indexing (v2 filter upgrade)
- [ ] `/range` real SCAN-cursor pagination (known O(N)/OOM risk today; offset-style API preserved)
- [ ] Metadata filter pushdown into RediSearch (v1 over-fetch + JS filter remains)
```

Do not rewrite earlier architecture sections beyond Phase 7 truth and any one-line status notes.

- [ ] **Step 5: Optional sparse-hybrid note**

Only if you want a timestamp:

```markdown
Still deferred as of 2026-07-17 (maintenance pass; no sparse/hybrid implementation).
```

- [ ] **Step 6: Lint/format docs-touched tree**

```bash
bun run lint:fix
bun run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add README.md Claude.md PLAN.md docs/architecture/sparse-hybrid.md
git commit -m "$(cat <<'EOF'
docs: sync test counts, metrics token env, Phase 7 data endpoints

Record post-maintenance suite totals and mark provider-backed upsert-data/query-data done.
EOF
)"
```

- [ ] **Step 8: PR description checklist**

Open PR titled:

> Maintenance: deps, SDK surface audit, LOW hardening, doc truth

Body must include:

```markdown
## Summary
- Safe dep patches (hono / biome)
- Local SDK surface audit vs @upstash/vector@1.2.3 (no live cloud)
- LOW: metrics optional token, embedding error sanitize, IN() cap 256, /random include flags
- Docs/counts/PLAN Phase 7 truth

## Test counts
- Unit: <U>, Integration: <I>, Compatibility: <C>, Total: <T>

## SDK surface audit
- <paste Task 3 notes>

## Still out of scope
- /range real cursor pagination
- Filter pushdown
- Sparse / hybrid
- Resumable queries
- Multi-token mode
- Live Upstash Cloud parity diff
```

---

### Task 9 (conditional): Production bugs found during audit

**Files:** only those required for the specific bug + regression test

**Interfaces:** PR #2 style — live repro against Redis Stack, minimal fix, no unrelated refactors

- [ ] **Step 1: Confirm it is not a deferred architecture item**

If the issue is `/range` memory, selective filter under-topK, sparse, resumable, multi-token → **document only** in PR body; do not redesign.

- [ ] **Step 2: Repro → failing test → fix → green → commit**

```bash
# pattern
UPVECTOR_TOKEN=test bun test tests/unit/<file>.ts
# or integration against Redis Stack
git add <files>
git commit -m "fix: <specific production bug>"
```

---

## Testing Plan (cross-cutting)

| Layer | What |
|-------|------|
| Unit | Filter `IN` cap; embedding client-facing sanitization; metrics auth helpers |
| Integration | `/random` include flags; business routes still 401 without token |
| Compatibility | Full `tests/compatibility` with pinned SDK; weekly job covers `@latest` |
| Local gate | `./scripts/test-all.sh` |
| Negative | Sparse still rejected; resumable still 501; no FLUSHALL “fixes” for dirty Redis |

## Risk & Rollback

| Risk | Mitigation |
|------|------------|
| Dep bump breaks Biome/Hono types | Revert single package; patch-only |
| Metrics token surprises operators | Opt-in env; default unchanged when unset; docs |
| `/random` default change breaks clients | Default `includeVectors: true` |
| Over-scoping into range/filter redesign | Non-goals checklist; reject architecture diffs |
| Test isolation false failures | Fresh Redis; restart after flush |

Rollback: single PR revert. No migration/data format changes. Filter cap and error sanitization are request-path only. Metrics token is config-only.

## Deliverables Checklist

- [ ] Full test green; counts recorded
- [ ] `hono` / biome patch bumps (or documented skip if already current)
- [ ] `@upstash/vector` confirmed latest pin
- [ ] Surface audit notes in PR body
- [ ] LOW items 4.1–4.4 implemented + tests
- [ ] README / Claude.md / PLAN.md Phase 7 synced
- [ ] CI workflows reviewed; fixed only if needed
- [ ] PR lists deferred items still out of scope

## Self-Review (plan vs spec)

| Spec workstream | Task |
|-----------------|------|
| 1 Baseline | Task 1 |
| 2 SDK/API audit | Task 3 |
| 3 Safe deps | Task 2 |
| 4.1 metrics auth | Task 7 |
| 4.2 embedding sanitize | Task 4 |
| 4.3 IN cap | Task 5 |
| 4.4 random flags | Task 6 |
| 5 Docs / Phase 7 | Task 8 |
| 6 CI health | Task 3 Step 5 + Task 8 review |
| 7 Bugs during audit | Task 9 |
| Non-goals preserved | Global Constraints + Task 9 gate |

No placeholders remaining; all cited paths exist in the repo as of plan write time.
