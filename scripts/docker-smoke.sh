#!/bin/bash
set -euo pipefail

IMAGE="${1:-up-vector:smoke}"
REDIS_TAG="${2:-7.4.0-v8}"
SMOKE_NAME="up-vector-smoke-$$"
cleanup() {
	docker rm -f "${SMOKE_NAME}-app" "${SMOKE_NAME}-redis" >/dev/null 2>&1 || true
	docker network rm "$SMOKE_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create "$SMOKE_NAME" >/dev/null
docker run -d --name "${SMOKE_NAME}-redis" --network "$SMOKE_NAME" \
	"redis/redis-stack-server:${REDIS_TAG}" >/dev/null
docker run -d --name "${SMOKE_NAME}-app" --network "$SMOKE_NAME" \
	-e UPVECTOR_TOKEN=smoke-token \
	-e "UPVECTOR_REDIS_URL=redis://${SMOKE_NAME}-redis:6379" \
	"$IMAGE" >/dev/null

# Exercise the final image with its own runtime. No host ports, production data,
# external SDK credentials, or additional floating curl image are needed.
docker exec "${SMOKE_NAME}-app" bun -e '
const base = "http://localhost:8080"
const headers = { Authorization: "Bearer smoke-token", "Content-Type": "application/json" }
const pause = () => new Promise(resolve => setTimeout(resolve, 100))
let ready = false
for (let i = 0; i < 300; i++) {
  try { if ((await fetch(`${base}/health`)).ok) { ready = true; break } } catch {}
  await pause()
}
if (!ready) throw new Error("Artifact never became healthy")
if ((await fetch(`${base}/info`)).status !== 401) throw new Error("Artifact auth failed")
const post = async (path, body) => {
  const response = await fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) })
  const value = await response.json()
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(value)}`)
  return value.result
}
const vector = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]
if (await post("/upsert", { id: "smoke-1", vector, metadata: { source: "smoke" } }) !== "Success") {
  throw new Error("Artifact upsert failed")
}
let hit
for (let i = 0; i < 100; i++) {
  const rows = await post("/query", { vector, topK: 1, includeVectors: true, includeMetadata: true })
  hit = rows[0]
  if (hit) break
  await pause()
}
if (hit?.id !== "smoke-1" || hit.metadata?.source !== "smoke" || hit.vector?.length !== 8 || Math.abs(hit.score - 1) > 0.0001) {
  throw new Error(`Artifact query roundtrip failed: ${JSON.stringify(hit)}`)
}
console.log(`Docker artifact smoke passed; Bun ${Bun.version}`)
'
