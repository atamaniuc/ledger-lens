#!/usr/bin/env bash
# Thin wrapper around `omc ask codex --agent-prompt <role>`, for the second-opinion
# passes CLAUDE.md's Phase 2 and Delegation Ladder call for (architect/critic/review).
set -euo pipefail

if [ $# -lt 2 ]; then
  cat >&2 <<EOF
Usage: $(basename "$0") <role> <prompt-file|->
  role: architect | critic | review | any free-form label omc ask accepts
  prompt-file: path to a file with the prompt, or - to read stdin

Examples:
  $(basename "$0") architect .claude/DESIGN.md
  git diff main... | $(basename "$0") review -
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
