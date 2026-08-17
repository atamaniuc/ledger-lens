#!/usr/bin/env bash
# Thin wrapper around `omc ask codex --agent-prompt <role>`, for the second-opinion
# passes CLAUDE.md's Phase 2 and Delegation Ladder call for.
#
# `role` is NOT a free-form label — `omc ask` validates it against a fixed
# roster of agent-prompt files (verified by running this against a real
# invalid role and reading the CLI's own error): analyst, architect,
# code-reviewer, code-simplifier, critic, debugger, designer,
# document-specialist, executor, explore, git-master, planner, qa-tester,
# scientist, security-reviewer, test-engineer, tracer, verifier, writer.
# For review purposes use `code-reviewer`, not `review` — an earlier
# version of this script and codex-review.sh assumed `review` was valid;
# it isn't, `omc ask` rejects it outright.
set -euo pipefail

if [ $# -lt 2 ]; then
  cat >&2 <<EOF
Usage: $(basename "$0") <role> <prompt-file|->
  role: architect | critic | code-reviewer | any other role in the fixed
        roster above — omc ask rejects anything outside it
  prompt-file: path to a file with the prompt, or - to read stdin

Examples:
  $(basename "$0") architect .claude/DESIGN.md
  git diff main... | $(basename "$0") code-reviewer -
EOF
  exit 1
fi

ROLE="$1"
SRC="$2"

if ! command -v codex >/dev/null 2>&1; then
  echo "codex CLI not found (which codex). Falling back is CLAUDE.md's rule for omc-plan," \
       "but this raw wrapper has nothing to fall back to — install codex first." >&2
  exit 1
fi

if [ "$SRC" = "-" ]; then
  PROMPT="$(cat)"
else
  PROMPT="$(cat "$SRC")"
fi

omc ask codex --agent-prompt "$ROLE" "$PROMPT"
