import { evaluate } from "./evaluator"
import { parse } from "./parser"
import { tokenize } from "./tokenizer"

export { evaluate, globToRegex, resolveField } from "./evaluator"
export { parse } from "./parser"
export { tokenize } from "./tokenizer"
export type { FilterNode, Token, TokenType, Value } from "./types"

export function evaluateFilter(filter: string, metadata: Record<string, unknown>): boolean {
	const tokens = tokenize(filter)
	const ast = parse(tokens)
	return evaluate(ast, metadata)
}
