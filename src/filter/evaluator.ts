import { ValidationError } from "../errors"
import type { FilterNode, Value } from "./types"

export function evaluate(node: FilterNode, metadata: Record<string, unknown>): boolean {
	switch (node.type) {
		case "and":
			return evaluate(node.left, metadata) && evaluate(node.right, metadata)
		case "or":
			return evaluate(node.left, metadata) || evaluate(node.right, metadata)
		case "comparison":
			return evalComparison(resolveField(metadata, node.field), node.op, node.value)
		case "glob": {
			const val = resolveField(metadata, node.field)
			const match = typeof val === "string" && compileGlob(node.pattern).test(val)
			return node.negated ? !match : match
		}
		case "in": {
			const val = resolveField(metadata, node.field)
			const match = node.values.some((v) => looseEqual(val, v))
			return node.negated ? !match : match
		}
		case "contains": {
			const val = resolveField(metadata, node.field)
			if (!Array.isArray(val)) return node.negated
			const match = val.some((item) => looseEqual(item, node.value))
			return node.negated ? !match : match
		}
		case "has_field": {
			const val = resolveField(metadata, node.field)
			const exists = val !== undefined
			return node.negated ? !exists : exists
		}
	}
}

// Reject these segment names so a malicious filter can't read prototype methods
// (constructor, toString, valueOf, ...) via metadata field paths.
function isUnsafeKey(key: string): boolean {
	return key === "__proto__" || key === "constructor" || key === "prototype"
}

export function resolveField(obj: Record<string, unknown>, path: string): unknown {
	// Split on dots, but respect bracket notation
	const segments = splitFieldPath(path)
	let current: unknown = obj

	for (const seg of segments) {
		if (current === null || current === undefined) return undefined
		if (typeof current !== "object") return undefined

		// Array index: numeric or #-N
		const bracketMatch = seg.match(/^([^[]+)\[(.+)\]$/)
		if (bracketMatch) {
			const [, key, indexExpr] = bracketMatch
			if (isUnsafeKey(key)) return undefined
			// Use Object.hasOwn to avoid inherited properties
			const arr =
				typeof current === "object" && current !== null && Object.hasOwn(current, key)
					? (current as Record<string, unknown>)[key]
					: undefined
			if (!Array.isArray(arr)) return undefined

			let idx: number
			if (indexExpr.startsWith("#")) {
				// Backward indexing: #-1 = last, #-2 = second to last
				const offset = Number(indexExpr.slice(1))
				idx = arr.length + offset
			} else {
				idx = Number(indexExpr)
			}

			if (!Number.isInteger(idx) || idx < 0 || idx >= arr.length) return undefined
			current = arr[idx]
		} else {
			if (isUnsafeKey(seg)) return undefined
			current =
				typeof current === "object" && current !== null && Object.hasOwn(current, seg)
					? (current as Record<string, unknown>)[seg]
					: undefined
		}
	}

	return current
}

function splitFieldPath(path: string): string[] {
	// Split on dots, but keep bracket expressions attached to their field name
	// e.g., "a.b[0].c" → ["a", "b[0]", "c"]
	const segments: string[] = []
	let current = ""

	for (let i = 0; i < path.length; i++) {
		if (path[i] === "." && !current.includes("[")) {
			if (current) segments.push(current)
			current = ""
		} else if (path[i] === "." && current.includes("[") && current.includes("]")) {
			// The bracket is already closed, so this dot starts a new segment
			if (current) segments.push(current)
			current = ""
		} else {
			current += path[i]
		}
	}
	if (current) segments.push(current)

	return segments
}

function evalComparison(fieldValue: unknown, op: string, target: Value): boolean {
	if (fieldValue === undefined || fieldValue === null) return false

	switch (op) {
		case "=":
			return looseEqual(fieldValue, target)
		case "!=":
			return !looseEqual(fieldValue, target)
		case "<":
			return toNumber(fieldValue) < toNumber(target)
		case "<=":
			return toNumber(fieldValue) <= toNumber(target)
		case ">":
			return toNumber(fieldValue) > toNumber(target)
		case ">=":
			return toNumber(fieldValue) >= toNumber(target)
		default:
			return false
	}
}

function looseEqual(a: unknown, b: unknown): boolean {
	// String comparison (most common)
	if (typeof a === "string" && typeof b === "string") return a === b
	// Number comparison
	if (typeof a === "number" && typeof b === "number") return a === b
	// Boolean comparison
	if (typeof a === "boolean" && typeof b === "boolean") return a === b
	// Cross-type: number/string coercion. The string must be a non-empty
	// numeric literal — otherwise Number("") === 0 silently makes `= ''`
	// match metadata values of 0.
	if (typeof a === "number" && typeof b === "string") {
		return b.trim() !== "" && !Number.isNaN(Number(b)) && a === Number(b)
	}
	if (typeof a === "string" && typeof b === "number") {
		return a.trim() !== "" && !Number.isNaN(Number(a)) && Number(a) === b
	}
	// Boolean/non-boolean: only the truthy equivalents 1 and 'true' may cross
	// the type boundary. Without this guard, `false` matched literal 0 because
	// both sides of the old expression reduced to false.
	if (typeof a === "boolean") return a ? b === 1 || b === "true" : false
	if (typeof b === "boolean") return b ? a === 1 || a === "true" : false
	return a === b
}

function toNumber(val: unknown): number {
	if (typeof val === "number") return val
	if (typeof val === "string") return Number(val)
	if (typeof val === "boolean") return val ? 1 : 0
	return Number.NaN
}

const MAX_GLOB_PATTERN_LENGTH = 512
const globCache = new Map<string, GlobMatcher>()
const MAX_GLOB_CACHE_SIZE = 256

// A compiled glob pattern. Matching runs an NFA scan over the subject
// (worst-case O(n·k)) instead of building a RegExp whose free `.*` wildcards
// backtrack catastrophically on adversarial subjects.
export type GlobMatcher = {
	test(subject: string): boolean
}

type GlobToken =
	| { kind: "literal"; ch: string }
	| { kind: "any" }
	| { kind: "class"; negated: boolean; singles: Set<string>; ranges: Array<[number, number]> }
	| { kind: "star" }

// Compile one [...] character class. Ranges must be in ascending order
// ([z-a] throws), mirroring the SyntaxError the old RegExp-based compiler
// surfaced lazily during evaluation.
function compileGlobClass(body: string): GlobToken {
	const negated = body.startsWith("^")
	const content = negated ? body.slice(1) : body
	const singles = new Set<string>()
	const ranges: Array<[number, number]> = []
	let j = 0
	while (j < content.length) {
		if (j + 2 < content.length && content[j + 1] === "-") {
			const lo = content.charCodeAt(j)
			const hi = content.charCodeAt(j + 2)
			if (lo > hi) {
				throw new ValidationError(
					`Invalid glob pattern: range out of order in character class '${content.slice(j, j + 3)}'`,
				)
			}
			ranges.push([lo, hi])
			j += 3
		} else {
			singles.add(content[j])
			j++
		}
	}
	return { kind: "class", negated, singles, ranges }
}

// Tokenize the pattern into literals, ?, [...], and * (consecutive * collapse).
// An unclosed [ is treated as a literal, matching the old behavior.
function compileTokens(pattern: string): GlobToken[] {
	const tokens: GlobToken[] = []
	let i = 0
	while (i < pattern.length) {
		const ch = pattern[i]
		if (ch === "*") {
			while (i + 1 < pattern.length && pattern[i + 1] === "*") i++
			tokens.push({ kind: "star" })
		} else if (ch === "?") {
			tokens.push({ kind: "any" })
		} else if (ch === "[") {
			const close = pattern.indexOf("]", i + 1)
			if (close === -1) {
				for (; i < pattern.length; i++) tokens.push({ kind: "literal", ch: pattern[i] })
				continue
			}
			tokens.push(compileGlobClass(pattern.slice(i + 1, close)))
			i = close
		} else {
			tokens.push({ kind: "literal", ch })
		}
		i++
	}
	return tokens
}

function classMatches(token: Extract<GlobToken, { kind: "class" }>, ch: string): boolean {
	let hit = token.singles.has(ch)
	if (!hit && token.ranges.length > 0) {
		const code = ch.charCodeAt(0)
		for (const [lo, hi] of token.ranges) {
			if (code >= lo && code <= hi) {
				hit = true
				break
			}
		}
	}
	return token.negated ? !hit : hit
}

function createMatcher(tokens: GlobToken[]): GlobMatcher {
	const n = tokens.length
	const WORDS = (n >> 5) + 1

	// State bitsets: bit i of dp means tokens[0..i-1] match some prefix of the
	// subject. Transitions run word-parallel: consuming a character shifts the
	// state set left one position and masks it with that character's acceptance
	// mask; stars additionally persist in place (they absorb any sequence).
	// Per character this costs O(k/32) word ops plus O(#stars) for the epsilon
	// closure — worst-case O(n·k) overall, with no backtracking.
	const starMask = new Uint32Array(WORDS)
	const starIdx: number[] = []
	for (let i = 0; i < n; i++) {
		if (tokens[i].kind === "star") {
			starMask[i >> 5] |= 1 << (i & 31)
			starIdx.push(i)
		}
	}

	// Acceptance masks are cached per character code and stored PRE-SHIFTED:
	// a character accepted by token i sets bit i+1, matching how the DP
	// transition pairs each shifted state with the token about to consume it.
	// Subjects with unusually rich alphabets stop growing the cache and fall
	// back to ad-hoc masks, so memory stays bounded.
	const acceptCache = new Map<number, Uint32Array>()
	const MAX_CACHED_CHARS = 1024

	function accepts(token: GlobToken, ch: string): boolean {
		if (token.kind === "any") return true
		if (token.kind === "literal") return token.ch === ch
		if (token.kind === "class") return classMatches(token, ch)
		return false
	}

	function acceptMask(code: number, ch: string): Uint32Array {
		const cached = acceptCache.get(code)
		if (cached) return cached
		const mask = new Uint32Array(WORDS)
		for (let i = 0; i < n; i++) {
			if (accepts(tokens[i], ch)) {
				const pos = i + 1
				mask[pos >> 5] |= 1 << (pos & 31)
			}
		}
		if (acceptCache.size < MAX_CACHED_CHARS) acceptCache.set(code, mask)
		return mask
	}

	// Epsilon closure: a star may also match the empty sequence.
	function propagateStars(buf: Uint32Array): void {
		for (let s = 0; s < starIdx.length; s++) {
			const idx = starIdx[s]
			if (buf[idx >> 5] & (1 << (idx & 31))) buf[(idx + 1) >> 5] |= 1 << ((idx + 1) & 31)
		}
	}

	let dp = new Uint32Array(WORDS)
	let next = new Uint32Array(WORDS)

	return {
		test(subject: string): boolean {
			dp.fill(0)
			dp[0] = 1
			propagateStars(dp)
			for (let s = 0; s < subject.length; s++) {
				const ch = subject[s]
				const mask = acceptMask(ch.charCodeAt(0), ch)
				next.fill(0)
				let carry = 0
				for (let w = 0; w < WORDS; w++) {
					next[w] = (((dp[w] << 1) | carry) & mask[w]) | (dp[w] & starMask[w])
					carry = dp[w] >>> 31
				}
				propagateStars(next)
				let live = 0
				for (let w = 0; w < WORDS; w++) live |= next[w]
				if (live === 0) return false
				const swap = dp
				dp = next
				next = swap
			}
			return (dp[n >> 5] & (1 << (n & 31))) !== 0
		},
	}
}

export function compileGlob(pattern: string): GlobMatcher {
	if (pattern.length > MAX_GLOB_PATTERN_LENGTH) {
		throw new ValidationError(`Glob pattern too long (max ${MAX_GLOB_PATTERN_LENGTH} chars)`)
	}
	const cached = globCache.get(pattern)
	if (cached) {
		// Refresh LRU position by re-inserting (matches the filter AST cache).
		// Without this, hot patterns get evicted just because they were inserted
		// early — defeating the point of caching them.
		globCache.delete(pattern)
		globCache.set(pattern, cached)
		return cached
	}
	const compiled = createMatcher(compileTokens(pattern))
	if (globCache.size >= MAX_GLOB_CACHE_SIZE) {
		const firstKey = globCache.keys().next().value
		if (firstKey !== undefined) globCache.delete(firstKey)
	}
	globCache.set(pattern, compiled)
	return compiled
}
