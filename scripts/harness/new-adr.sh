#!/usr/bin/env bash
# Scaffold a new ADR at .claude/adr/NNNN-<slug>.md per CLAUDE.md Phase 1 step 4.
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $(basename "$0") <title> [--supersedes NNNN]" >&2
  exit 1
fi

TITLE="$1"
SUPERSEDES=""
if [ "${2:-}" = "--supersedes" ]; then
  SUPERSEDES="${3:-}"
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ADR_DIR="$REPO_ROOT/.claude/adr"
mkdir -p "$ADR_DIR"

SLUG="$(echo "$TITLE" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g')"

LAST_NUM=$(find "$ADR_DIR" -maxdepth 1 -name '[0-9][0-9][0-9][0-9]-*.md' -print 2>/dev/null \
  | sed -E 's#.*/([0-9]{4})-.*#\1#' | sort -n | tail -1)
NEXT_NUM=$(printf '%04d' "$(( ${LAST_NUM:-0} + 1 ))")

FILE="$ADR_DIR/${NEXT_NUM}-${SLUG}.md"
if [ -e "$FILE" ]; then
  echo "Refusing to overwrite existing $FILE" >&2
  exit 1
fi

{
  echo "# ${NEXT_NUM}: ${TITLE}"
  echo
  echo "Status: Proposed"
  if [ -n "$SUPERSEDES" ]; then
    echo
    echo "Supersedes: ${SUPERSEDES} (mark that ADR's Status as \`Superseded by ${NEXT_NUM}\` — don't silently edit it)"
  fi
  echo
  echo "## Context"
  echo
  echo "## Decision"
  echo
  echo "## Consequences"
  echo
  echo "## Alternatives considered"
  echo
} > "$FILE"

echo "$FILE"
