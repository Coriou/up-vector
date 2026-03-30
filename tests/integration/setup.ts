const BASE_URL = process.env.UPVECTOR_TEST_URL ?? "http://localhost:8080"
const TOKEN = process.env.UPVECTOR_TOKEN ?? "test-token-123"

export const AUTH = { Authorization: `Bearer ${TOKEN}` }
export const HEADERS = { ...AUTH, "Content-Type": "application/json" }

export async function api(
	method: string,
	path: string,
	body?: unknown,
): Promise<{ status: number; data: unknown }> {
	const res = await fetch(`${BASE_URL}${path}`, {
		method,
		headers: HEADERS,
		body: body ? JSON.stringify(body) : undefined,
	})
	const data = await res.json()
	return { status: res.status, data }
}

export async function resetAll(): Promise<void> {
	await api("POST", "/reset?all=true")
}
