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
			current = (current as Record<string, unknown>)[key]
			if (!Array.isArray(current)) return undefined

			let idx: number
			if (indexExpr.startsWith("#")) {
				// Backward indexing: #-1 = last, #-2 = second to last
				const offset = Number(indexExpr.slice(1))
				idx = current.length + offset
			} else {
				idx = Number(indexExpr)
			}

			if (idx < 0 || idx >= current.length) return undefined
			current = current[idx]
		} else {
			current = (current as Record<string, unknown>)[seg]
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

export function globToRegex(pattern: string): RegExp {
	let regex = ""
	let i = 0
	while (i < pattern.length) {
		const ch = pattern[i]
		if (ch === "*") {
			regex += ".*"
		} else if (ch === "?") {
			regex += "."
		} else if (ch === "[") {
			// Pass through character classes
			regex += "["
			i++
			while (i < pattern.length && pattern[i] !== "]") {
				regex += pattern[i]
				i++
			}
			regex += "]"
		} else if (".+^${}()|\\".includes(ch)) {
			regex += `\\${ch}`
		} else {
			regex += ch
		}
		i++
	}
	return new RegExp(`^${regex}$`)
}
