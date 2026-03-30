#!/bin/bash
set -e

echo "=== Starting Redis Stack ==="
docker compose -f docker-compose.yml -f docker-compose.dev.yml up redis -d
sleep 3

echo "=== Starting up-vector ==="
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
