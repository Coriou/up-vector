import type { FilterNode, Token, Value } from "./types"

export function parse(tokens: Token[]): FilterNode {
	let pos = 0

	function peek() {
		return tokens[pos]
	}

	function advance() {
		return tokens[pos++]
	}

	function expect(type: string): Token {
		const tok = peek()
		if (tok.type !== type) {
			throw new Error(`Expected ${type} but got ${tok.type} at position ${tok.pos}`)
		}
		return advance()
	}

	function parseValue(): Value {
		const tok = peek()
		if (
			tok.type === "STRING" ||
			tok.type === "NUMBER" ||
			tok.type === "TRUE" ||
			tok.type === "FALSE"
		) {
			advance()
			return tok.value as Value
		}
		throw new Error(`Expected value but got ${tok.type} at position ${tok.pos}`)
	}

	function parseValueList(): Value[] {
		expect("LPAREN")
		const values: Value[] = [parseValue()]
		while (peek().type === "COMMA") {
			advance() // skip comma
			values.push(parseValue())
		}
		expect("RPAREN")
		return values
	}

	function parsePrimary(): FilterNode {
		const tok = peek()

		// Parenthesized expression
		if (tok.type === "LPAREN") {
			advance()
			const node = parseOr()
			expect("RPAREN")
			return node
		}

		// HAS [NOT] FIELD identifier
		if (tok.type === "HAS") {
			advance()
			let negated = false
			if (peek().type === "NOT") {
				advance()
				negated = true
			}
			expect("FIELD")
			const field = expect("IDENTIFIER").value as string
			return { type: "has_field", field, negated }
		}

		// IDENTIFIER comparison_tail
		if (tok.type === "IDENTIFIER") {
			const field = advance().value as string
			return parseComparisonTail(field)
		}

		throw new Error(`Unexpected token ${tok.type} at position ${tok.pos}`)
	}

	function parseComparisonTail(field: string): FilterNode {
		const tok = peek()

		// Standard comparison operators
		if (
			tok.type === "EQ" ||
			tok.type === "NEQ" ||
			tok.type === "LT" ||
			tok.type === "LTE" ||
			tok.type === "GT" ||
			tok.type === "GTE"
		) {
			const opMap: Record<string, "=" | "!=" | "<" | "<=" | ">" | ">="> = {
				EQ: "=",
				NEQ: "!=",
				LT: "<",
				LTE: "<=",
				GT: ">",
				GTE: ">=",
			}
			const op = opMap[advance().type]
			const value = parseValue()
			return { type: "comparison", field, op, value }
		}

		// [NOT] GLOB string
		if (tok.type === "GLOB") {
			advance()
			const pattern = expect("STRING").value as string
			return { type: "glob", field, pattern, negated: false }
		}
		if (tok.type === "NOT" && tokens[pos + 1]?.type === "GLOB") {
			advance() // NOT
			advance() // GLOB
			const pattern = expect("STRING").value as string
			return { type: "glob", field, pattern, negated: true }
		}

		// [NOT] IN (value_list)
		if (tok.type === "IN") {
			advance()
			const values = parseValueList()
			return { type: "in", field, values, negated: false }
		}
		if (tok.type === "NOT" && tokens[pos + 1]?.type === "IN") {
			advance() // NOT
			advance() // IN
			const values = parseValueList()
			return { type: "in", field, values, negated: true }
		}

		// [NOT] CONTAINS value
		if (tok.type === "CONTAINS") {
			advance()
			const value = parseValue()
			return { type: "contains", field, value, negated: false }
		}
		if (tok.type === "NOT" && tokens[pos + 1]?.type === "CONTAINS") {
			advance() // NOT
			advance() // CONTAINS
			const value = parseValue()
			return { type: "contains", field, value, negated: true }
		}

		throw new Error(
			`Expected operator after field '${field}' but got ${tok.type} at position ${tok.pos}`,
		)
	}

	function parseAnd(): FilterNode {
		let left = parsePrimary()
		while (peek().type === "AND") {
			advance()
			const right = parsePrimary()
			left = { type: "and", left, right }
		}
		return left
	}

	function parseOr(): FilterNode {
		let left = parseAnd()
		while (peek().type === "OR") {
			advance()
			const right = parseAnd()
			left = { type: "or", left, right }
		}
		return left
	}

	const ast = parseOr()

	if (peek().type !== "EOF") {
		const tok = peek()
		throw new Error(`Unexpected token ${tok.type} at position ${tok.pos}`)
	}

	return ast
}
