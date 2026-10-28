import { afterAll, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const directory = mkdtempSync(join(tmpdir(), "up-vector-gates-"))
const sha = "a".repeat(40)
const run = {
	head_sha: sha,
	head_branch: "main",
	head_repository: { full_name: "Coriou/up-vector" },
	event: "workflow_dispatch",
	status: "completed",
	conclusion: "success",
}
writeFileSync(
	join(directory, "gh"),
	`#!/bin/bash
set -eu
if [[ "$*" == *git/ref/heads/main* ]]; then
  printf '%s' "$MOCK_MAIN"
elif [[ "$*" == *"$MOCK_WORKFLOW"* ]]; then
  printf '%s' "$MOCK_RUNS"
else
  printf '%s' "$MOCK_GREEN"
fi
`,
)
chmodSync(join(directory, "gh"), 0o755)
afterAll(() => rmSync(directory, { recursive: true, force: true }))

function check(runs = [run], extra: Record<string, string | undefined> = {}) {
	return Bun.spawnSync(["bash", resolve("scripts/verify-publication-gates.sh")], {
		env: {
			...process.env,
			PATH: `${directory}:${process.env.PATH}`,
			GITHUB_REPOSITORY: "Coriou/up-vector",
			GITHUB_SHA: sha,
			GITHUB_REF: "refs/heads/main",
			GITHUB_EVENT_NAME: "workflow_dispatch",
			MOCK_MAIN: sha,
			MOCK_WORKFLOW: "compat.yml",
			MOCK_GREEN: JSON.stringify({ workflow_runs: [run] }),
			MOCK_RUNS: JSON.stringify({ workflow_runs: runs }),
			...extra,
		},
	})
}

test("publication accepts all three successful exact-SHA gates", () => {
	const result = check()
	expect(result.exitCode).toBe(0)
	expect(result.stdout.toString().match(/Verified/g)).toHaveLength(3)
})

test("publication rejects each missing gate", () => {
	for (const workflow of ["test.yml", "compat.yml", "maintenance.yml"]) {
		const result = check([], { MOCK_WORKFLOW: workflow })
		expect(result.exitCode).toBe(1)
		expect(result.stderr.toString()).toContain(workflow)
	}
})

test("publication rejects pending, failed, skipped and cancelled latest runs despite older success", () => {
	for (const [status, conclusion] of [
		["in_progress", ""],
		["queued", ""],
		["completed", "failure"],
		["completed", "skipped"],
		["completed", "cancelled"],
	]) {
		expect(check([{ ...run, status, conclusion }, run]).exitCode).toBe(1)
	}
})

test("publication rejects mismatched SHA, branch, repository and PR runs", () => {
	for (const change of [
		{ head_sha: "b".repeat(40) },
		{ head_branch: "feature" },
		{ head_repository: { full_name: "outsider/up-vector" } },
		{ event: "pull_request" },
	]) {
		expect(check([{ ...run, ...change }]).exitCode).toBe(1)
	}
})

test("publication rejects non-main, non-manual and stale main dispatches", () => {
	for (const extra of [
		{ GITHUB_REF: "refs/heads/feature" },
		{ GITHUB_EVENT_NAME: "push" },
		{ MOCK_MAIN: "b".repeat(40) },
	]) {
		expect(check([run], extra).exitCode).toBe(1)
	}
})
