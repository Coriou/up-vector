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
			const match = typeof val === "string" && globToRegex(node.pattern).test(val)
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
	// Cross-type: number/string coercion
	if (typeof a === "number" && typeof b === "string") return a === Number(b)
	if (typeof a === "string" && typeof b === "number") return Number(a) === b
	// Boolean/number coercion
	if (typeof a === "boolean") return a === (b === 1 || b === true || b === "true")
	if (typeof b === "boolean") return b === (a === 1 || a === true || a === "true")
	return a === b
}

function toNumber(val: unknown): number {
	if (typeof val === "number") return val
	if (typeof val === "string") return Number(val)
	if (typeof val === "boolean") return val ? 1 : 0
	return Number.NaN
}

const MAX_GLOB_PATTERN_LENGTH = 512
const globCache = new Map<string, RegExp>()
const MAX_GLOB_CACHE_SIZE = 256

export function globToRegex(pattern: string): RegExp {
	if (pattern.length > MAX_GLOB_PATTERN_LENGTH) {
		throw new Error(`Glob pattern too long (max ${MAX_GLOB_PATTERN_LENGTH} chars)`)
	}
	const cached = globCache.get(pattern)
	if (cached) return cached

	let regex = ""
	let i = 0
	while (i < pattern.length) {
		const ch = pattern[i]
		if (ch === "*") {
			// Collapse consecutive wildcards to prevent catastrophic backtracking
			while (i + 1 < pattern.length && pattern[i + 1] === "*") i++
			regex += ".*"
		} else if (ch === "?") {
			regex += "."
		} else if (ch === "[") {
			// Pass through character classes — ensure bracket is closed
			i++ // skip [
			let classContent = ""
			while (i < pattern.length && pattern[i] !== "]") {
				classContent += pattern[i]
				i++
			}
			if (i >= pattern.length) {
				// Unclosed bracket — treat the opening [ as a literal
				regex += "\\["
				regex += classContent.replace(/[.*+?^${}()|\\[\]]/g, "\\$&")
				continue // i is already at end, loop will terminate
			}
			regex += `[${classContent}]`
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal regex metacharacters, not template
		} else if (".+^${}()|\\".includes(ch)) {
			regex += `\\${ch}`
		} else {
			regex += ch
		}
		i++
	}
	const compiled = new RegExp(`^${regex}$`)
	// Evict oldest entries if cache is full
	if (globCache.size >= MAX_GLOB_CACHE_SIZE) {
		const firstKey = globCache.keys().next().value
		if (firstKey !== undefined) globCache.delete(firstKey)
	}
	globCache.set(pattern, compiled)
	return compiled
}
