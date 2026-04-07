import { describe, expect, test } from "bun:test"
import {
	indexName,
	NS_REGISTRY,
	parseVectorKey,
	validateId,
	validateNamespace,
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

describe("validateNamespace", () => {
	test("accepts empty string (default namespace)", () => {
		expect(() => validateNamespace("")).not.toThrow()
	})

	test("accepts valid namespace names", () => {
		expect(() => validateNamespace("prod")).not.toThrow()
		expect(() => validateNamespace("test-123")).not.toThrow()
		expect(() => validateNamespace("my_namespace")).not.toThrow()
	})

	test("rejects namespace with colons", () => {
		expect(() => validateNamespace("ns:with:colons")).toThrow("must not contain ':'")
	})

	test("rejects single colon", () => {
		expect(() => validateNamespace(":")).toThrow("must not contain ':'")
	})
})

describe("validateId", () => {
	test("accepts non-empty IDs", () => {
		expect(() => validateId("doc-1")).not.toThrow()
		expect(() => validateId("123")).not.toThrow()
		expect(() => validateId("id:with:colons")).not.toThrow()
	})

	test("rejects empty string ID", () => {
		expect(() => validateId("")).toThrow("must not be empty")
	})

	test("rejects ID exceeding max length", () => {
		expect(() => validateId("x".repeat(1025))).toThrow("must not exceed")
	})

	test("accepts ID at max length", () => {
		expect(() => validateId("x".repeat(1024))).not.toThrow()
	})
})

describe("validateNamespace length", () => {
	test("rejects namespace exceeding max length", () => {
		expect(() => validateNamespace("x".repeat(257))).toThrow("must not exceed")
	})

	test("accepts namespace at max length", () => {
		expect(() => validateNamespace("x".repeat(256))).not.toThrow()
	})
})

describe("validateNamespace hardening", () => {
	test("rejects glob metacharacters that would break SCAN MATCH", () => {
		expect(() => validateNamespace("foo*")).toThrow("glob characters")
		expect(() => validateNamespace("foo?")).toThrow("glob characters")
		expect(() => validateNamespace("foo[bar]")).toThrow("glob characters")
		expect(() => validateNamespace("foo\\bar")).toThrow("glob characters")
	})

	test("rejects control characters", () => {
		expect(() => validateNamespace("foo\nbar")).toThrow("control characters")
		expect(() => validateNamespace("foo\x00bar")).toThrow("control characters")
		expect(() => validateNamespace("foo\x7fbar")).toThrow("control characters")
	})

	test("accepts unicode and high-ASCII", () => {
		expect(() => validateNamespace("ünüversél")).not.toThrow()
		expect(() => validateNamespace("中文")).not.toThrow()
	})
})

describe("validateId hardening", () => {
	test("rejects control characters", () => {
		expect(() => validateId("foo\nbar")).toThrow("control characters")
		expect(() => validateId("foo\x00bar")).toThrow("control characters")
	})

	test("accepts colons in IDs (the v:{ns}:{id} scheme tolerates them)", () => {
		expect(() => validateId("user:42:profile")).not.toThrow()
	})
})
