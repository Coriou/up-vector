import { evaluate } from "./evaluator"
import { parse } from "./parser"
import { tokenize } from "./tokenizer"

export { tokenize } from "./tokenizer"
export { parse } from "./parser"
export { evaluate, resolveField, globToRegex } from "./evaluator"
export type { Token, TokenType, FilterNode, Value } from "./types"

export function evaluateFilter(filter: string, metadata: Record<string, unknown>): boolean {
	const tokens = tokenize(filter)
	const ast = parse(tokens)
	return evaluate(ast, metadata)
}
