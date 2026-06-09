#!/bin/bash
set -e

is_port_free() {
	! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

find_free_port() {
	local port="$1"
	while ! is_port_free "$port"; do
		port=$((port + 1))
	done
	echo "$port"
}

export UPVECTOR_REDIS_PORT="${UPVECTOR_REDIS_PORT:-$(find_free_port 6379)}"
export UPVECTOR_PORT="${UPVECTOR_PORT:-$(find_free_port 8080)}"
export UPVECTOR_REDIS_URL="${UPVECTOR_REDIS_URL:-redis://localhost:${UPVECTOR_REDIS_PORT}}"
export UPVECTOR_TEST_URL="${UPVECTOR_TEST_URL:-http://localhost:${UPVECTOR_PORT}}"
export UPVECTOR_URL="${UPVECTOR_URL:-${UPVECTOR_TEST_URL}}"
export UPVECTOR_EMBEDDING_PROVIDER="${UPVECTOR_EMBEDDING_PROVIDER:-fake}"
export UPVECTOR_EMBEDDING_MODEL="${UPVECTOR_EMBEDDING_MODEL:-fake-embedding}"
export UPVECTOR_EMBEDDING_DIMENSION="${UPVECTOR_EMBEDDING_DIMENSION:-8}"

echo "=== Starting Redis Stack ==="
echo "Redis: ${UPVECTOR_REDIS_URL}"
docker compose -f docker-compose.yml -f docker-compose.dev.yml up redis -d
sleep 3

echo "=== Starting up-vector ==="
echo "HTTP: ${UPVECTOR_TEST_URL}"
UPVECTOR_TOKEN=test-token-123 bun run src/index.ts &
SERVER_PID=$!
sleep 2

cleanup() {
	echo "=== Cleaning up ==="
	kill "$SERVER_PID" 2>/dev/null || true
	docker compose down 2>/dev/null || true
}
trap cleanup EXIT

echo "=== Type check ==="
bun run typecheck

echo "=== Lint ==="
bun run lint

echo "=== Unit tests ==="
UPVECTOR_TOKEN=test bun test tests/unit

echo "=== Integration tests ==="
UPVECTOR_TOKEN=test-token-123 bun test tests/integration

echo "=== SDK compatibility tests ==="
UPVECTOR_TOKEN=test-token-123 bun test tests/compatibility

echo ""
echo "All tests passed!"
