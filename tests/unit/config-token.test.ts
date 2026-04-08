import { describe, expect, test } from "bun:test"
import { z } from "zod"

// We can't re-import config.ts with a different env (modules are cached and
// the module reads `process.env` at import time). Instead, mirror just the
// token charset rule from src/config.ts here so any future drift between the
// test and the real schema fails the test loudly.
const BEARER_TOKEN_CHARSET = /^[A-Za-z0-9._~+/-]+=*$/
const tokenSchema = z
	.string()
	.min(1, "UPVECTOR_TOKEN is required")
	.refine(
		(t) => BEARER_TOKEN_CHARSET.test(t),
		"UPVECTOR_TOKEN must only contain RFC 6750 bearer token characters",
	)

describe("UPVECTOR_TOKEN charset rule", () => {
	test("accepts a typical token", () => {
		expect(() => tokenSchema.parse("test-token-123")).not.toThrow()
	})

	test("accepts the full RFC 6750 charset", () => {
		// 1*(ALPHA / DIGIT / "-" / "." / "_" / "~" / "+" / "/") *"="
		expect(() => tokenSchema.parse("Aa0._~+/-")).not.toThrow()
		expect(() => tokenSchema.parse("Aa0._~+/-=")).not.toThrow()
		expect(() => tokenSchema.parse("Aa0._~+/-==")).not.toThrow()
	})

	test("rejects a colon", () => {
		expect(() => tokenSchema.parse("bad:token")).toThrow("RFC 6750")
	})

	test("rejects whitespace", () => {
		expect(() => tokenSchema.parse("bad token")).toThrow("RFC 6750")
	})

	test("rejects control characters", () => {
		expect(() => tokenSchema.parse("bad\nnewline")).toThrow("RFC 6750")
		expect(() => tokenSchema.parse("bad\x00null")).toThrow("RFC 6750")
	})

	test("rejects empty string", () => {
		expect(() => tokenSchema.parse("")).toThrow("required")
	})

	test("rejects unicode", () => {
		expect(() => tokenSchema.parse("café")).toThrow("RFC 6750")
	})

	test("rejects = anywhere except trailing", () => {
		expect(() => tokenSchema.parse("foo=bar")).toThrow("RFC 6750")
	})

	test("ensures src/config.ts uses the same regex", async () => {
		// Smoke test: read the file and confirm it still references the
		// charset constant. If you rename or change it, this fires so we
		// remember to update both sides.
		const text = await Bun.file("src/config.ts").text()
		expect(text).toContain("[A-Za-z0-9._~+/-]+=*")
	})
})
