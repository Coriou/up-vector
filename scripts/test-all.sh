#!/bin/bash
set -euo pipefail

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
export UPVECTOR_REDIS_URL="redis://localhost:${UPVECTOR_REDIS_PORT}"
export UPVECTOR_TEST_URL="http://localhost:${UPVECTOR_PORT}"
export UPVECTOR_URL="${UPVECTOR_TEST_URL}"
export UPVECTOR_TOKEN=test-token-123
export UPVECTOR_EMBEDDING_PROVIDER=fake
export UPVECTOR_EMBEDDING_MODEL=fake-embedding
export UPVECTOR_EMBEDDING_DIMENSION=8

# Never reuse production Redis data or stop the user's default Compose project.
TEST_PROJECT="up-vector-test-$$"
SERVER_PID=""
compose() {
	docker compose -p "$TEST_PROJECT" -f docker-compose.yml -f docker-compose.dev.yml "$@"
}
cleanup() {
	if [ -n "$SERVER_PID" ]; then
		kill "$SERVER_PID" 2>/dev/null || true
		wait "$SERVER_PID" 2>/dev/null || true
	fi
	compose down --volumes >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_for() {
	local attempt
	for attempt in {1..30}; do
		if "$@"; then return 0; fi
		sleep 1
	done
	echo "Readiness probe failed" >&2
	return 1
}

compose up redis -d
wait_for compose exec -T redis redis-cli ping >/dev/null
bun run src/index.ts &
SERVER_PID=$!
wait_for curl -sf "${UPVECTOR_TEST_URL}/health" >/dev/null

bun run typecheck
bun run lint
UPVECTOR_TOKEN=test bun test tests/unit
bun test tests/integration
bun test tests/compatibility
bun run build
