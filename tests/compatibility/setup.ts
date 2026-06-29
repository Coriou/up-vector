import { Index } from "@upstash/vector"

export const TOKEN = process.env.UPVECTOR_TOKEN ?? "test-token-123"
// Prefer UPVECTOR_TEST_URL so a single env var points the whole test suite
// (integration + compatibility) at one server; keep UPVECTOR_URL as a fallback
// for back-compat.
export const URL =
	process.env.UPVECTOR_TEST_URL ?? process.env.UPVECTOR_URL ?? "http://localhost:8080"

export function createIndex(): Index {
	return new Index({ url: URL, token: TOKEN })
}

export function randomID(): string {
	return `test_${Math.random().toString(36).slice(2, 10)}_${Date.now()}`
}

export function randomVector(dim = 384): number[] {
	return Array.from({ length: dim }, () => Math.random())
}

export async function awaitIndexed(delayMs = 500): Promise<void> {
	await new Promise((r) => setTimeout(r, delayMs))
}
