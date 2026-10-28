#!/bin/bash
# No polling: operators dispatch missing gates and retry publication when green.
set -euo pipefail

: "${GITHUB_REPOSITORY:?}" "${GITHUB_SHA:?}" "${GITHUB_REF:?}" "${GITHUB_EVENT_NAME:?}"
if [[ "$GITHUB_REF" != refs/heads/main || "$GITHUB_EVENT_NAME" != workflow_dispatch ]]; then
	echo '::error::Publication requires workflow_dispatch on main.' >&2
	exit 1
fi
main_sha=$(gh api "repos/${GITHUB_REPOSITORY}/git/ref/heads/main" --jq '.object.sha')
if [[ "$main_sha" != "$GITHUB_SHA" ]]; then
	echo '::error::main has moved; dispatch gates and publication again on the current main SHA.' >&2
	exit 1
fi
for workflow in test.yml compat.yml maintenance.yml; do
	# Do not filter status=success: a newer pending/failed run must block an old green run.
	runs=$(gh api --method GET "repos/${GITHUB_REPOSITORY}/actions/workflows/${workflow}/runs" \
		-f head_sha="$GITHUB_SHA" -f branch=main -f per_page=1)
	if ! jq -e --arg sha "$GITHUB_SHA" --arg repo "$GITHUB_REPOSITORY" '
		.workflow_runs[0] |
		.head_sha == $sha and .head_branch == "main" and
		.head_repository.full_name == $repo and
		(.event == "push" or .event == "workflow_dispatch" or .event == "schedule") and
		.status == "completed" and .conclusion == "success"
	' <<< "$runs" >/dev/null; then
		echo "::error::${workflow} needs a successful latest main run for ${GITHUB_SHA}; missing, pending or unsuccessful. Run the gate, then retry publication." >&2
		exit 1
	fi
	jq -r '.workflow_runs[0] | "Verified \(.name): \(.html_url) (\(.head_sha))"' <<< "$runs"
done
