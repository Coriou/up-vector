import { ValidationError } from "../errors"
import { getClient } from "../redis"

export const NS_REGISTRY = "_ns_registry"
export const EMBEDDING_NS_REGISTRY = "_embedding_ns_registry"
export const MAX_SCAN_ITERATIONS = 10_000

const MAX_NAMESPACE_LENGTH = 256
const MAX_ID_LENGTH = 1024
const MAX_PREFIX_LENGTH = 1024

// biome-ignore lint/suspicious/noControlCharactersInRegex: deliberate — reject these
const CONTROL_CHARS = /[\x00-\x1f\x7f]/
// Glob metacharacters that would break or escape Redis SCAN MATCH patterns.
const GLOB_META = /[*?[\]\\]/

/** Validates that a namespace name won't corrupt the key scheme or scan patterns. */
export function validateNamespace(ns: string): void {
	if (ns.includes(":")) {
		throw new ValidationError("Namespace name must not contain ':'")
	}
	if (CONTROL_CHARS.test(ns)) {
		throw new ValidationError("Namespace name must not contain control characters")
	}
	// Glob characters in namespaces would break SCAN MATCH patterns and could allow
	// cross-namespace key matching during prefix-based fetch/delete.
	if (GLOB_META.test(ns)) {
		throw new ValidationError("Namespace name must not contain glob characters (* ? [ ] \\)")
	}
	if (ns.length > MAX_NAMESPACE_LENGTH) {
		throw new ValidationError(`Namespace name must not exceed ${MAX_NAMESPACE_LENGTH} characters`)
	}
}

/** Validates that an ID is non-empty, not too long, and printable. */
export function validateId(id: string): void {
	if (id === "") {
		throw new ValidationError("Vector ID must not be empty")
	}
	if (CONTROL_CHARS.test(id)) {
		throw new ValidationError("Vector ID must not contain control characters")
	}
	if (id.length > MAX_ID_LENGTH) {
		throw new ValidationError(`Vector ID must not exceed ${MAX_ID_LENGTH} characters`)
	}
}

/**
 * Validates a user-supplied id prefix used to build a SCAN MATCH pattern.
 *
 * Glob metacharacters are allowed for Upstash parity (Upstash treats prefix as
 * a literal string, and ids may legally contain `* ? [ ] \`); the pattern
 * builders escape them via escapeGlobMeta so they match literally instead of
 * acting as wildcards. Control characters are still rejected and length is
 * bounded to keep SCAN cursors small. (deep audit 2026-09-06, F11)
 */
export function validatePrefix(prefix: string): void {
	if (CONTROL_CHARS.test(prefix)) {
		throw new ValidationError("Prefix must not contain control characters")
	}
	if (prefix.length > MAX_PREFIX_LENGTH) {
		throw new ValidationError(`Prefix must not exceed ${MAX_PREFIX_LENGTH} characters`)
	}
}

/**
 * Escapes Redis glob metacharacters so a user prefix matches literally inside
 * a SCAN MATCH pattern. Namespaces are validated glob-free, so escaping the
 * prefix alone is enough to keep every pattern anchored to its namespace
 * subtree.
 */
export function escapeGlobMeta(value: string): string {
	return value.replace(/[*?[\]\\]/g, (ch) => `\\${ch}`)
}

export function vectorKey(ns: string, id: string): string {
	return `v:${ns}:${id}`
}

export function vectorPrefix(ns: string): string {
	return `v:${ns}:`
}

export function indexName(ns: string): string {
	return `idx:${ns}`
}

export function parseVectorKey(key: string): { ns: string; id: string } | null {
	if (!key.startsWith("v:")) return null
	// Format: v:{ns}:{id} — ns never contains ":", but id can
	const afterV = key.slice(2) // remove "v:"
	const colonIdx = afterV.indexOf(":")
	if (colonIdx === -1) return null
	return {
		ns: afterV.slice(0, colonIdx),
		id: afterV.slice(colonIdx + 1),
	}
}

export async function deleteKeysByPattern(pattern: string): Promise<number> {
	const redis = getClient()
	// Pass cursors as strings end-to-end. Redis cursors are 64-bit unsigned ints
	// serialized as strings; converting to Number() risks precision loss above 2^53.
	let cursor = "0"
	let totalDeleted = 0
	const seen = new Set<string>()
	let iterations = 0
	do {
		if (++iterations > MAX_SCAN_ITERATIONS) {
			// Fail loudly like range.ts collectScanKeys: a truncated enumeration
			// presented as success let /reset and /delete claim completion while
			// matching keys survived. (deep audit 2026-09-06, F3)
			throw new ValidationError(
				`Keyspace exceeds the scanable key limit (${MAX_SCAN_ITERATIONS} SCAN iterations); deletion aborted`,
			)
		}
		const result = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100)
		const [next, keys] = result as unknown as [string, string[]]
		// SCAN can return duplicate keys across iterations — deduplicate
		const unique = keys.filter((k) => !seen.has(k))
		for (const k of unique) seen.add(k)
		if (unique.length > 0) {
			totalDeleted += await redis.del(...unique)
		}
		cursor = next
	} while (cursor !== "0")
	return totalDeleted
}
