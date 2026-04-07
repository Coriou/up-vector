import { evaluate } from "./evaluator"
import { parse } from "./parser"
import { tokenize } from "./tokenizer"
import type { FilterNode } from "./types"

export { evaluate, globToRegex, resolveField } from "./evaluator"
export { parse } from "./parser"
export { tokenize } from "./tokenizer"
export type { FilterNode, Token, TokenType, Value } from "./types"

// LRU cache for parsed filter ASTs. Most workloads issue many queries with a
// small set of filter strings, so reusing the AST avoids re-tokenizing and
// re-parsing on every request.
const FILTER_AST_CACHE_SIZE = 256
const filterAstCache = new Map<string, FilterNode>()

export function compileFilter(filter: string): FilterNode {
	const cached = filterAstCache.get(filter)
	if (cached) {
		// Refresh LRU position by re-inserting
		filterAstCache.delete(filter)
		filterAstCache.set(filter, cached)
		return cached
	}
	const ast = parse(tokenize(filter))
	if (filterAstCache.size >= FILTER_AST_CACHE_SIZE) {
		const oldest = filterAstCache.keys().next().value
		if (oldest !== undefined) filterAstCache.delete(oldest)
	}
	filterAstCache.set(filter, ast)
	return ast
}

export function evaluateFilter(filter: string, metadata: Record<string, unknown>): boolean {
	return evaluate(compileFilter(filter), metadata)
}

// Test helper — exported for unit tests that need to reset state between runs.
export function _clearFilterCache(): void {
	filterAstCache.clear()
}
