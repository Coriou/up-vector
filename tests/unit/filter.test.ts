import { describe, expect, test } from "bun:test"
import {
	_clearFilterCache,
	compileFilter,
	evaluate,
	evaluateFilter,
	globToRegex,
	parse,
	resolveField,
	tokenize,
} from "../../src/filter"

// ─── Tokenizer ──────────────────────────────────────────────────────────────

describe("tokenizer", () => {
	test("simple identifier", () => {
		const tokens = tokenize("country = 'Turkey'")
		expect(tokens[0]).toMatchObject({ type: "IDENTIFIER", value: "country" })
		expect(tokens[1]).toMatchObject({ type: "EQ" })
		expect(tokens[2]).toMatchObject({ type: "STRING", value: "Turkey" })
		expect(tokens[3]).toMatchObject({ type: "EOF" })
	})

	test("dotted identifier", () => {
		const tokens = tokenize("geo.continent = 'Asia'")
		expect(tokens[0]).toMatchObject({
			type: "IDENTIFIER",
			value: "geo.continent",
		})
	})

	test("deeply nested identifier", () => {
		const tokens = tokenize("a.b.c.d >= 1")
		expect(tokens[0]).toMatchObject({ type: "IDENTIFIER", value: "a.b.c.d" })
	})

	test("bracket access", () => {
		const tokens = tokenize("items[0] = 'x'")
		expect(tokens[0]).toMatchObject({ type: "IDENTIFIER", value: "items[0]" })
	})

	test("backward indexing", () => {
		const tokens = tokenize("items[#-1] = 'last'")
		expect(tokens[0]).toMatchObject({
			type: "IDENTIFIER",
			value: "items[#-1]",
		})
	})

	test("single-quoted string", () => {
		const tokens = tokenize("x = 'hello world'")
		expect(tokens[2]).toMatchObject({ type: "STRING", value: "hello world" })
	})

	test("double-quoted string", () => {
		const tokens = tokenize('x = "hello"')
		expect(tokens[2]).toMatchObject({ type: "STRING", value: "hello" })
	})

	test("escaped quote in string", () => {
		const tokens = tokenize("x = 'it\\'s'")
		expect(tokens[2]).toMatchObject({ type: "STRING", value: "it's" })
	})

	test("integer", () => {
		const tokens = tokenize("x > 42")
		expect(tokens[2]).toMatchObject({ type: "NUMBER", value: 42 })
	})

	test("negative float", () => {
		const tokens = tokenize("x <= -3.14")
		expect(tokens[2]).toMatchObject({ type: "NUMBER", value: -3.14 })
	})

	test("boolean true", () => {
		const tokens = tokenize("active = true")
		expect(tokens[2]).toMatchObject({ type: "TRUE", value: true })
	})

	test("boolean false (case insensitive)", () => {
		const tokens = tokenize("active = FALSE")
		expect(tokens[2]).toMatchObject({ type: "FALSE", value: false })
	})

	test("all comparison operators", () => {
		const ops = ["=", "!=", "<", "<=", ">", ">="]
		const expected = ["EQ", "NEQ", "LT", "LTE", "GT", "GTE"] as const
		for (let i = 0; i < ops.length; i++) {
			const tokens = tokenize(`x ${ops[i]} 1`)
			expect(tokens[1].type).toBe(expected[i])
		}
	})

	test("keywords are case-insensitive", () => {
		expect(tokenize("x AND y = 1")[1].type).toBe("AND")
		expect(tokenize("x and y = 1")[1].type).toBe("AND")
		expect(tokenize("x Or y = 1")[1].type).toBe("OR")
	})

	test("parentheses and comma", () => {
		const tokens = tokenize("x IN ('a', 'b')")
		expect(tokens[2].type).toBe("LPAREN")
		expect(tokens[4].type).toBe("COMMA")
		expect(tokens[6].type).toBe("RPAREN")
	})
})

// ─── Parser ──────────────────────────────────────────────────────────────────

describe("parser", () => {
	test("simple equality", () => {
		const ast = parse(tokenize("country = 'Turkey'"))
		expect(ast).toEqual({
			type: "comparison",
			field: "country",
			op: "=",
			value: "Turkey",
		})
	})

	test("numeric comparison", () => {
		const ast = parse(tokenize("score >= 0.8"))
		expect(ast).toEqual({
			type: "comparison",
			field: "score",
			op: ">=",
			value: 0.8,
		})
	})

	test("AND expression", () => {
		const ast = parse(tokenize("a = 1 AND b = 2"))
		expect(ast.type).toBe("and")
	})

	test("OR expression", () => {
		const ast = parse(tokenize("a = 1 OR b = 2"))
		expect(ast.type).toBe("or")
	})

	test("AND binds tighter than OR", () => {
		const ast = parse(tokenize("a = 1 OR b = 2 AND c = 3"))
		// Should parse as: a = 1 OR (b = 2 AND c = 3)
		expect(ast.type).toBe("or")
		if (ast.type === "or") {
			expect(ast.right.type).toBe("and")
		}
	})

	test("parentheses override precedence", () => {
		const ast = parse(tokenize("(a = 1 OR b = 2) AND c = 3"))
		expect(ast.type).toBe("and")
		if (ast.type === "and") {
			expect(ast.left.type).toBe("or")
		}
	})

	test("GLOB", () => {
		const ast = parse(tokenize("title GLOB 'The *'"))
		expect(ast).toEqual({
			type: "glob",
			field: "title",
			pattern: "The *",
			negated: false,
		})
	})

	test("NOT GLOB", () => {
		const ast = parse(tokenize("title NOT GLOB 'Bad*'"))
		expect(ast).toEqual({
			type: "glob",
			field: "title",
			pattern: "Bad*",
			negated: true,
		})
	})

	test("IN with value list", () => {
		const ast = parse(tokenize("color IN ('red', 'blue', 'green')"))
		expect(ast).toEqual({
			type: "in",
			field: "color",
			values: ["red", "blue", "green"],
			negated: false,
		})
	})

	test("NOT IN", () => {
		const ast = parse(tokenize("status NOT IN ('deleted', 'archived')"))
		expect(ast).toEqual({
			type: "in",
			field: "status",
			values: ["deleted", "archived"],
			negated: true,
		})
	})

	test("CONTAINS", () => {
		const ast = parse(tokenize("tags CONTAINS 'featured'"))
		expect(ast).toEqual({
			type: "contains",
			field: "tags",
			value: "featured",
			negated: false,
		})
	})

	test("NOT CONTAINS", () => {
		const ast = parse(tokenize("tags NOT CONTAINS 'spam'"))
		expect(ast).toEqual({
			type: "contains",
			field: "tags",
			value: "spam",
			negated: true,
		})
	})

	test("HAS FIELD", () => {
		const ast = parse(tokenize("HAS FIELD email"))
		expect(ast).toEqual({ type: "has_field", field: "email", negated: false })
	})

	test("HAS NOT FIELD", () => {
		const ast = parse(tokenize("HAS NOT FIELD deleted_at"))
		expect(ast).toEqual({
			type: "has_field",
			field: "deleted_at",
			negated: true,
		})
	})

	test("complex compound expression", () => {
		const ast = parse(tokenize("genre IN ('comedy', 'drama') AND year > 2020 OR rating >= 4.5"))
		// (genre IN (...) AND year > 2020) OR (rating >= 4.5)
		expect(ast.type).toBe("or")
	})
})

// ─── resolveField ────────────────────────────────────────────────────────────

describe("resolveField", () => {
	test("simple field", () => {
		expect(resolveField({ name: "Alice" }, "name")).toBe("Alice")
	})

	test("dot notation", () => {
		expect(resolveField({ geo: { lat: 45.5 } }, "geo.lat")).toBe(45.5)
	})

	test("deep dot notation", () => {
		expect(resolveField({ a: { b: { c: { d: 1 } } } }, "a.b.c.d")).toBe(1)
	})

	test("missing field returns undefined", () => {
		expect(resolveField({ a: 1 }, "b")).toBeUndefined()
	})

	test("missing intermediate returns undefined", () => {
		expect(resolveField({ a: 1 }, "a.b.c")).toBeUndefined()
	})

	test("array indexing", () => {
		expect(resolveField({ items: ["a", "b", "c"] }, "items[0]")).toBe("a")
		expect(resolveField({ items: ["a", "b", "c"] }, "items[2]")).toBe("c")
	})

	test("backward indexing with #", () => {
		expect(resolveField({ items: ["a", "b", "c"] }, "items[#-1]")).toBe("c")
		expect(resolveField({ items: ["a", "b", "c"] }, "items[#-2]")).toBe("b")
	})

	test("out-of-bounds returns undefined", () => {
		expect(resolveField({ items: ["a"] }, "items[5]")).toBeUndefined()
	})

	test("array index on non-array returns undefined", () => {
		expect(resolveField({ items: "not-array" }, "items[0]")).toBeUndefined()
	})
})

// ─── globToRegex ─────────────────────────────────────────────────────────────

describe("globToRegex", () => {
	test("* matches any characters", () => {
		expect(globToRegex("The *").test("The Lord")).toBe(true)
		expect(globToRegex("The *").test("Something")).toBe(false)
	})

	test("? matches single character", () => {
		expect(globToRegex("h?t").test("hat")).toBe(true)
		expect(globToRegex("h?t").test("hot")).toBe(true)
		expect(globToRegex("h?t").test("heat")).toBe(false)
	})

	test("character class", () => {
		expect(globToRegex("[abc]at").test("cat")).toBe(true)
		expect(globToRegex("[abc]at").test("dat")).toBe(false)
	})

	test("negated character class", () => {
		expect(globToRegex("[^abc]at").test("dat")).toBe(true)
		expect(globToRegex("[^abc]at").test("cat")).toBe(false)
	})

	test("character range", () => {
		expect(globToRegex("[a-c]at").test("bat")).toBe(true)
		expect(globToRegex("[a-c]at").test("fat")).toBe(false)
	})

	test("escapes regex specials", () => {
		expect(globToRegex("file.txt").test("file.txt")).toBe(true)
		expect(globToRegex("file.txt").test("filextxt")).toBe(false)
	})

	test("rejects patterns exceeding max length", () => {
		const longPattern = "*".repeat(600)
		expect(() => globToRegex(longPattern)).toThrow("Glob pattern too long")
	})

	test("caches compiled regex", () => {
		const r1 = globToRegex("cache_test_*")
		const r2 = globToRegex("cache_test_*")
		expect(r1).toBe(r2) // same RegExp instance
	})
})

// ─── Evaluator ───────────────────────────────────────────────────────────────

describe("evaluator", () => {
	const meta = {
		color: "red",
		score: 0.9,
		count: 42,
		active: true,
		tags: ["featured", "popular"],
		geo: { continent: "Asia", city: "Istanbul" },
		items: ["first", "second", "third"],
		nested: { deep: { value: 100 } },
	}

	// Comparison operators
	test("= string", () => {
		expect(evaluate(parse(tokenize("color = 'red'")), meta)).toBe(true)
		expect(evaluate(parse(tokenize("color = 'blue'")), meta)).toBe(false)
	})

	test("!= string", () => {
		expect(evaluate(parse(tokenize("color != 'blue'")), meta)).toBe(true)
		expect(evaluate(parse(tokenize("color != 'red'")), meta)).toBe(false)
	})

	test("= number", () => {
		expect(evaluate(parse(tokenize("count = 42")), meta)).toBe(true)
		expect(evaluate(parse(tokenize("count = 43")), meta)).toBe(false)
	})

	test("< number", () => {
		expect(evaluate(parse(tokenize("score < 1.0")), meta)).toBe(true)
		expect(evaluate(parse(tokenize("score < 0.5")), meta)).toBe(false)
	})

	test("<= number", () => {
		expect(evaluate(parse(tokenize("score <= 0.9")), meta)).toBe(true)
		expect(evaluate(parse(tokenize("score <= 0.8")), meta)).toBe(false)
	})

	test("> number", () => {
		expect(evaluate(parse(tokenize("count > 40")), meta)).toBe(true)
		expect(evaluate(parse(tokenize("count > 42")), meta)).toBe(false)
	})

	test(">= number", () => {
		expect(evaluate(parse(tokenize("count >= 42")), meta)).toBe(true)
		expect(evaluate(parse(tokenize("count >= 43")), meta)).toBe(false)
	})

	test("= boolean", () => {
		expect(evaluate(parse(tokenize("active = true")), meta)).toBe(true)
		expect(evaluate(parse(tokenize("active = false")), meta)).toBe(false)
	})

	test("missing field in comparison returns false", () => {
		expect(evaluate(parse(tokenize("nonexistent = 'x'")), meta)).toBe(false)
	})

	// GLOB
	test("GLOB matches", () => {
		expect(evaluate(parse(tokenize("color GLOB 'r*'")), meta)).toBe(true)
		expect(evaluate(parse(tokenize("color GLOB 'b*'")), meta)).toBe(false)
	})

	test("NOT GLOB", () => {
		expect(evaluate(parse(tokenize("color NOT GLOB 'b*'")), meta)).toBe(true)
		expect(evaluate(parse(tokenize("color NOT GLOB 'r*'")), meta)).toBe(false)
	})

	test("GLOB with ? wildcard", () => {
		expect(evaluate(parse(tokenize("color GLOB 'r?d'")), meta)).toBe(true)
		expect(evaluate(parse(tokenize("color GLOB 'r??d'")), meta)).toBe(false)
	})

	// IN / NOT IN
	test("IN matches", () => {
		expect(evaluate(parse(tokenize("color IN ('red', 'blue')")), meta)).toBe(true)
		expect(evaluate(parse(tokenize("color IN ('green', 'yellow')")), meta)).toBe(false)
	})

	test("NOT IN", () => {
		expect(evaluate(parse(tokenize("color NOT IN ('green', 'yellow')")), meta)).toBe(true)
		expect(evaluate(parse(tokenize("color NOT IN ('red', 'blue')")), meta)).toBe(false)
	})

	test("IN with numbers", () => {
		expect(evaluate(parse(tokenize("count IN (41, 42, 43)")), meta)).toBe(true)
		expect(evaluate(parse(tokenize("count IN (1, 2, 3)")), meta)).toBe(false)
	})

	// CONTAINS / NOT CONTAINS
	test("CONTAINS on array", () => {
		expect(evaluate(parse(tokenize("tags CONTAINS 'featured'")), meta)).toBe(true)
		expect(evaluate(parse(tokenize("tags CONTAINS 'archived'")), meta)).toBe(false)
	})

	test("NOT CONTAINS on array", () => {
		expect(evaluate(parse(tokenize("tags NOT CONTAINS 'archived'")), meta)).toBe(true)
		expect(evaluate(parse(tokenize("tags NOT CONTAINS 'featured'")), meta)).toBe(false)
	})

	test("CONTAINS on non-array returns false", () => {
		expect(evaluate(parse(tokenize("color CONTAINS 'r'")), meta)).toBe(false)
	})

	// HAS FIELD / HAS NOT FIELD
	test("HAS FIELD", () => {
		expect(evaluate(parse(tokenize("HAS FIELD color")), meta)).toBe(true)
		expect(evaluate(parse(tokenize("HAS FIELD nonexistent")), meta)).toBe(false)
	})

	test("HAS NOT FIELD", () => {
		expect(evaluate(parse(tokenize("HAS NOT FIELD nonexistent")), meta)).toBe(true)
		expect(evaluate(parse(tokenize("HAS NOT FIELD color")), meta)).toBe(false)
	})

	test("HAS FIELD with dot notation", () => {
		expect(evaluate(parse(tokenize("HAS FIELD geo.continent")), meta)).toBe(true)
		expect(evaluate(parse(tokenize("HAS FIELD geo.missing")), meta)).toBe(false)
	})

	// Dot notation in comparisons
	test("dot notation comparison", () => {
		expect(evaluate(parse(tokenize("geo.continent = 'Asia'")), meta)).toBe(true)
		expect(evaluate(parse(tokenize("geo.city = 'Istanbul'")), meta)).toBe(true)
	})

	test("deep dot notation", () => {
		expect(evaluate(parse(tokenize("nested.deep.value >= 100")), meta)).toBe(true)
		expect(evaluate(parse(tokenize("nested.deep.value < 100")), meta)).toBe(false)
	})

	// Array indexing in comparisons
	test("array index comparison", () => {
		expect(evaluate(parse(tokenize("items[0] = 'first'")), meta)).toBe(true)
		expect(evaluate(parse(tokenize("items[2] = 'third'")), meta)).toBe(true)
	})

	test("backward index comparison", () => {
		expect(evaluate(parse(tokenize("items[#-1] = 'third'")), meta)).toBe(true)
		expect(evaluate(parse(tokenize("items[#-2] = 'second'")), meta)).toBe(true)
	})

	// AND / OR
	test("AND both true", () => {
		expect(evaluate(parse(tokenize("color = 'red' AND active = true")), meta)).toBe(true)
	})

	test("AND one false", () => {
		expect(evaluate(parse(tokenize("color = 'red' AND active = false")), meta)).toBe(false)
	})

	test("OR one true", () => {
		expect(evaluate(parse(tokenize("color = 'blue' OR active = true")), meta)).toBe(true)
	})

	test("OR both false", () => {
		expect(evaluate(parse(tokenize("color = 'blue' OR count = 0")), meta)).toBe(false)
	})

	// Complex real-world filters from Upstash docs
	test("population AND continent filter", () => {
		const m = { population: 1500000, geography: { continent: "Asia" } }
		expect(evaluateFilter("population >= 1000000 AND geography.continent = 'Asia'", m)).toBe(true)
		expect(evaluateFilter("population >= 2000000 AND geography.continent = 'Asia'", m)).toBe(false)
	})

	test("genre IN AND year filter", () => {
		const m = { genre: "comedy", year: 2022 }
		expect(evaluateFilter("genre IN ('comedy', 'drama') AND year > 2020", m)).toBe(true)
		expect(evaluateFilter("genre IN ('action') AND year > 2020", m)).toBe(false)
	})

	test("CONTAINS AND HAS FIELD", () => {
		const m = { tags: ["featured", "popular"], premium: true }
		expect(evaluateFilter("tags CONTAINS 'featured' AND HAS FIELD premium", m)).toBe(true)
	})

	test("GLOB OR compound with parens", () => {
		const m = { title: "The Matrix", rating: 4.8, reviews: 200 }
		expect(evaluateFilter("title GLOB 'The *' OR (rating >= 4.5 AND reviews > 100)", m)).toBe(true)
		const m2 = { title: "Inception", rating: 4.8, reviews: 200 }
		expect(evaluateFilter("title GLOB 'The *' OR (rating >= 4.5 AND reviews > 100)", m2)).toBe(true)
		const m3 = { title: "Inception", rating: 3.0, reviews: 50 }
		expect(evaluateFilter("title GLOB 'The *' OR (rating >= 4.5 AND reviews > 100)", m3)).toBe(
			false,
		)
	})
})

// ─── evaluateFilter convenience ──────────────────────────────────────────────

describe("evaluateFilter", () => {
	test("end-to-end simple", () => {
		expect(evaluateFilter("x = 1", { x: 1 })).toBe(true)
		expect(evaluateFilter("x = 2", { x: 1 })).toBe(false)
	})

	test("empty metadata", () => {
		expect(evaluateFilter("x = 1", {})).toBe(false)
	})
})

// ─── Hardening: edge cases ──────────────────────────────────────────────────

describe("globToRegex hardening", () => {
	test("consecutive wildcards are collapsed", () => {
		const re = globToRegex("a***b")
		expect(re.test("axyzb")).toBe(true)
		expect(re.test("ab")).toBe(true)
		expect(re.test("axb")).toBe(true)
	})

	test("unclosed bracket treated as literal", () => {
		const re = globToRegex("[abc")
		expect(re.test("[abc")).toBe(true)
		expect(re.test("a")).toBe(false)
	})

	test("empty pattern matches empty string", () => {
		const re = globToRegex("")
		expect(re.test("")).toBe(true)
		expect(re.test("a")).toBe(false)
	})
})

describe("tokenizer error handling", () => {
	test("unterminated string throws", () => {
		expect(() => tokenize("name = 'unclosed")).toThrow("Unterminated string")
	})

	test("unexpected character throws", () => {
		expect(() => tokenize("name = @bad")).toThrow("Unexpected character")
	})
})

describe("parser error handling", () => {
	test("missing value after operator throws", () => {
		expect(() => parse(tokenize("x ="))).toThrow()
	})

	test("unclosed parenthesis throws", () => {
		expect(() => parse(tokenize("(x = 1"))).toThrow()
	})

	test("extra tokens after expression throws", () => {
		expect(() => parse(tokenize("x = 1 y = 2"))).toThrow()
	})
})

describe("evaluator edge cases", () => {
	test("null metadata values treated as missing", () => {
		expect(evaluate(parse(tokenize("x = 1")), { x: null })).toBe(false)
	})

	test("IN with empty list after parse", () => {
		// Manual AST — parser requires at least one value in IN list
		const ast = { type: "in" as const, field: "x", values: [], negated: false }
		expect(evaluate(ast, { x: 1 })).toBe(false)
	})

	test("CONTAINS on non-existent field", () => {
		expect(evaluateFilter("missing CONTAINS 'val'", { other: "x" })).toBe(false)
	})

	test("GLOB on non-string field returns false", () => {
		expect(evaluateFilter("count GLOB '*'", { count: 42 })).toBe(false)
	})

	test("HAS FIELD with array index path", () => {
		expect(evaluateFilter("HAS FIELD items", { items: [1, 2] })).toBe(true)
		expect(evaluateFilter("HAS NOT FIELD items", { items: [1, 2] })).toBe(false)
	})

	test("comparison with boolean coercion", () => {
		expect(evaluateFilter("active = true", { active: true })).toBe(true)
		expect(evaluateFilter("active = true", { active: 1 })).toBe(true)
		expect(evaluateFilter("active = false", { active: false })).toBe(true)
	})
})

describe("filter hardening", () => {
	test("rejects filter strings exceeding max length", () => {
		const longFilter = `${"x".repeat(8193)} = 'a'`
		expect(() => tokenize(longFilter)).toThrow("Filter string too long")
	})

	test("rejects deeply nested parentheses", () => {
		// Build a filter with 101 nested parens
		const open = "(".repeat(101)
		const close = ")".repeat(101)
		const deepFilter = `${open}x = 1${close}`
		expect(() => parse(tokenize(deepFilter))).toThrow("too deeply nested")
	})

	test("accepts moderately nested parentheses", () => {
		// 10 levels of nesting should be fine
		const open = "(".repeat(10)
		const close = ")".repeat(10)
		const filter = `${open}x = 1${close}`
		const ast = parse(tokenize(filter))
		expect(evaluate(ast, { x: 1 })).toBe(true)
	})
})

describe("tokenizer hardening: prototype keys", () => {
	test("__proto__ is treated as a normal IDENTIFIER", () => {
		// Using a Map for KEYWORDS prevents prototype methods from being mis-tokenized
		const tokens = tokenize("__proto__ = 1")
		expect(tokens[0].type).toBe("IDENTIFIER")
		expect(tokens[0].value).toBe("__proto__")
	})

	test("constructor is treated as a normal IDENTIFIER", () => {
		const tokens = tokenize("constructor = 1")
		expect(tokens[0].type).toBe("IDENTIFIER")
		expect(tokens[0].value).toBe("constructor")
	})

	test("__proto__ filter never matches metadata", () => {
		// resolveField rejects unsafe keys, so __proto__ is treated as missing
		expect(evaluateFilter("__proto__ = 1", { color: "red" })).toBe(false)
		expect(evaluateFilter("constructor != 'foo'", { color: "red" })).toBe(false)
		expect(evaluateFilter("HAS FIELD __proto__", { color: "red" })).toBe(false)
		expect(evaluateFilter("HAS FIELD constructor", { color: "red" })).toBe(false)
	})

	test("inherited properties (toString, valueOf) cannot be read", () => {
		expect(evaluateFilter("HAS FIELD toString", { color: "red" })).toBe(false)
		expect(evaluateFilter("HAS FIELD valueOf", { color: "red" })).toBe(false)
		expect(evaluateFilter("HAS FIELD hasOwnProperty", { color: "red" })).toBe(false)
	})

	test("nested __proto__ paths cannot be read", () => {
		const meta = { user: { name: "alice" } }
		expect(evaluateFilter("user.__proto__ != 'x'", meta)).toBe(false)
		expect(evaluateFilter("user.constructor != 'x'", meta)).toBe(false)
	})
})

describe("tokenizer hardening: bracket expressions", () => {
	test("unclosed bracket throws clear error", () => {
		expect(() => tokenize("items[0")).toThrow("Unclosed array index")
		expect(() => tokenize("items[abc = 1")).toThrow()
	})

	test("non-numeric bracket content throws", () => {
		expect(() => tokenize("items[abc]")).toThrow("Invalid character")
		expect(() => tokenize("items[__proto__]")).toThrow("Invalid character")
	})

	test("bracket length is bounded", () => {
		const longIndex = `items[${"1".repeat(50)}]`
		expect(() => tokenize(longIndex)).toThrow("Array index too long")
	})

	test("valid bracket expressions still work", () => {
		expect(tokenize("items[0]")[0].value).toBe("items[0]")
		expect(tokenize("items[42]")[0].value).toBe("items[42]")
		expect(tokenize("items[#-1]")[0].value).toBe("items[#-1]")
	})
})

describe("compileFilter cache", () => {
	test("returns the same AST for the same filter string", () => {
		_clearFilterCache()
		const ast1 = compileFilter("color = 'red'")
		const ast2 = compileFilter("color = 'red'")
		expect(ast1).toBe(ast2)
	})

	test("returns different ASTs for different filter strings", () => {
		_clearFilterCache()
		const ast1 = compileFilter("color = 'red'")
		const ast2 = compileFilter("color = 'blue'")
		expect(ast1).not.toBe(ast2)
	})

	test("evicts oldest when cache is full", () => {
		_clearFilterCache()
		// Fill the cache (default 256 entries)
		for (let i = 0; i < 256; i++) {
			compileFilter(`x = ${i}`)
		}
		const first = compileFilter("x = 0")
		// Inserting one more should evict "x = 1" (the next oldest after 0 was just touched)
		compileFilter("x = 999")
		// "x = 0" was just touched and should still be cached
		const firstAgain = compileFilter("x = 0")
		expect(firstAgain).toBe(first)
	})

	test("propagates parser errors through cache", () => {
		_clearFilterCache()
		expect(() => compileFilter("x =")).toThrow()
		// Errors should not be cached — a fresh attempt still throws
		expect(() => compileFilter("x =")).toThrow()
	})
})
