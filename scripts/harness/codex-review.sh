#!/usr/bin/env bash
# Send the working-tree diff to Codex as an external reviewer — the "swap in
# code-reviewer / outside opinion" step of CLAUDE.md's Delegation Ladder,
# except sourced from Codex instead of Claude's own code-reviewer agent.
set -euo pipefail

REF="${1:-HEAD}"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "Not inside a git repository." >&2
  exit 1
}
cd "$REPO_ROOT"

DIFF="$(git diff "$REF")"
if [ -z "$DIFF" ]; then
  echo "No diff against $REF — nothing to review." >&2
  exit 0
fi

PROMPT="Review this diff for correctness bugs, RLS/security regressions, and missed test coverage. Be specific: file, line, problem, fix. Repo conventions are in CLAUDE.md (RLS on every table, correlation_id in logs, run_id on data rows, idempotent ingestion).

Diff:
${DIFF}"

"$(dirname "${BASH_SOURCE[0]}")/ask-codex.sh" code-reviewer - <<< "$PROMPT"
