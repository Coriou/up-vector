import { describe, expect, test } from "bun:test"
import {
	NS_REGISTRY,
	indexName,
	parseVectorKey,
	vectorKey,
	vectorPrefix,
} from "../../src/translate/keys"

describe("key generation", () => {
	test("vectorKey with default namespace", () => {
		expect(vectorKey("", "doc-1")).toBe("v::doc-1")
	})

	test("vectorKey with named namespace", () => {
		expect(vectorKey("prod", "42")).toBe("v:prod:42")
	})

	test("vectorKey with numeric-looking id", () => {
		expect(vectorKey("ns", "123")).toBe("v:ns:123")
	})

	test("vectorPrefix with default namespace", () => {
		expect(vectorPrefix("")).toBe("v::")
	})

	test("vectorPrefix with named namespace", () => {
		expect(vectorPrefix("test")).toBe("v:test:")
	})

	test("indexName with default namespace", () => {
		expect(indexName("")).toBe("idx:")
	})

	test("indexName with named namespace", () => {
		expect(indexName("prod")).toBe("idx:prod")
	})
})

describe("parseVectorKey", () => {
	test("default namespace", () => {
		expect(parseVectorKey("v::doc-1")).toEqual({ ns: "", id: "doc-1" })
	})

	test("named namespace", () => {
		expect(parseVectorKey("v:prod:42")).toEqual({ ns: "prod", id: "42" })
	})

	test("id containing colons", () => {
		expect(parseVectorKey("v:ns:id:with:colons")).toEqual({
			ns: "ns",
			id: "id:with:colons",
		})
	})

	test("invalid key returns null", () => {
		expect(parseVectorKey("other:key")).toBeNull()
	})

	test("no colon after namespace returns null", () => {
		expect(parseVectorKey("v:nocolon")).toBeNull()
	})
})

describe("constants", () => {
	test("NS_REGISTRY", () => {
		expect(NS_REGISTRY).toBe("_ns_registry")
	})
})
