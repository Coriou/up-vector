import { describe, expect, test } from "bun:test"
import { deriveIdleTimeoutSeconds } from "../../src/index"

describe("deriveIdleTimeoutSeconds", () => {
	test("derives the default request budget with headroom", () => {
		expect(deriveIdleTimeoutSeconds(30000)).toBe(35)
	})

	test("returns Bun's maximum ceiling when the app-level timeout is disabled", () => {
		expect(deriveIdleTimeoutSeconds(0)).toBe(255)
	})

	test("clamps to the 15s floor for tiny budgets", () => {
		expect(deriveIdleTimeoutSeconds(1000)).toBe(15)
		expect(deriveIdleTimeoutSeconds(9500)).toBe(15)
	})

	test("rounds up partial seconds above the floor", () => {
		expect(deriveIdleTimeoutSeconds(10001)).toBe(16)
	})

	test("clamps to the 255s ceiling for huge budgets", () => {
		expect(deriveIdleTimeoutSeconds(600000)).toBe(255)
	})
})
