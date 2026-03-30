export type TokenType =
	| "IDENTIFIER"
	| "STRING"
	| "NUMBER"
	| "TRUE"
	| "FALSE"
	| "EQ"
	| "NEQ"
	| "LT"
	| "LTE"
	| "GT"
	| "GTE"
	| "AND"
	| "OR"
	| "NOT"
	| "GLOB"
	| "IN"
	| "CONTAINS"
	| "HAS"
	| "FIELD"
	| "LPAREN"
	| "RPAREN"
	| "COMMA"
	| "EOF"

export type Token = {
	type: TokenType
	value: string | number | boolean
	pos: number
}

export type Value = string | number | boolean

export type FilterNode =
	| { type: "and"; left: FilterNode; right: FilterNode }
	| { type: "or"; left: FilterNode; right: FilterNode }
	| { type: "comparison"; field: string; op: "=" | "!=" | "<" | "<=" | ">" | ">="; value: Value }
	| { type: "glob"; field: string; pattern: string; negated: boolean }
	| { type: "in"; field: string; values: Value[]; negated: boolean }
	| { type: "contains"; field: string; value: Value; negated: boolean }
	| { type: "has_field"; field: string; negated: boolean }
