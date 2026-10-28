import { expect, test } from "bun:test"
import { mergePatch } from "../../src/merge-patch"

test("merge patch replaces arrays, removes null members and preserves nested objects", () => {
	expect(
		mergePatch(
			{ a: { b: 1 }, list: [1], remove: true },
			{
				a: { c: 2 },
				list: [],
				remove: null,
			},
		),
	).toEqual({ a: { b: 1, c: 2 }, list: [] })
	expect(mergePatch({ a: [1] }, { a: {} })).toEqual({ a: {} })
})

test("merge patch treats prototype names as ordinary data without mutating input", () => {
	const base = JSON.parse('{"__proto__":{"safe":1},"constructor":{"a":2}}')
	const patch = JSON.parse('{"__proto__":{"new":3},"constructor":{"b":4}}')
	const merged = mergePatch(base, patch)
	expect(JSON.parse(JSON.stringify(merged))).toEqual(
		JSON.parse('{"__proto__":{"safe":1,"new":3},"constructor":{"a":2,"b":4}}'),
	)
	expect(Object.getOwnPropertyDescriptor(base, "__proto__")?.value).toEqual({ safe: 1 })
	expect(Object.prototype).not.toHaveProperty("new")
})
