#!/usr/bin/env bash
# Append (or replace) a "## <feature>" section in .claude/PRD.md per CLAUDE.md
# Phase 0.
#
# Two modes:
#   - Interactive/no stdin: writes an empty Problem/User/Success criteria/
#     Non-goals skeleton for you to fill in by hand.
#   - Piped stdin: writes whatever you pipe in as the section body verbatim
#     (e.g. `planner`/`analyst` agent output, or a heredoc). Useful for
#     scripted/agent-driven PRD generation instead of hand-editing.
#
# By default refuses to duplicate a section that already exists. Pass
# --force to replace an existing section's content instead.
set -euo pipefail

FORCE=0
ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--force" ]; then
    FORCE=1
  else
    ARGS+=("$arg")
  fi
done

if [ "${#ARGS[@]}" -lt 1 ]; then
  cat >&2 <<EOF
Usage: $(basename "$0") [--force] <feature-name>

Examples:
  $(basename "$0") "Mock Provider"                       # empty skeleton
  $(basename "$0") --force "Mock Provider" <<< "\$body"   # replace with content
  some-agent-output | $(basename "$0") --force "Mock Provider"
EOF
  exit 1
fi

FEATURE="${ARGS[0]}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PRD="$REPO_ROOT/.claude/PRD.md"
HEADING="## ${FEATURE}"

mkdir -p "$(dirname "$PRD")"
if [ ! -f "$PRD" ]; then
  echo "# LedgerLens — Product Requirements" > "$PRD"
  echo >> "$PRD"
fi

EXISTS=0
if grep -qxF "$HEADING" "$PRD"; then
  EXISTS=1
fi

if [ "$EXISTS" -eq 1 ] && [ "$FORCE" -ne 1 ]; then
  echo "Section '$HEADING' already exists in $PRD — not duplicating. Use --force to replace it." >&2
  exit 1
fi

if [ "$EXISTS" -eq 1 ] && [ "$FORCE" -eq 1 ]; then
  awk -v heading="$HEADING" '
    $0 == heading { skip=1; next }
    skip && /^## / { skip=0 }
    !skip { print }
  ' "$PRD" > "$PRD.tmp"
  mv "$PRD.tmp" "$PRD"
fi

if [ -t 0 ]; then
  {
    echo "$HEADING"
    echo
    echo "**Problem:**"
    echo
    echo "**User:**"
    echo
    echo "**Success criteria:**"
    echo
    echo "**Non-goals:**"
    echo
  } >> "$PRD"
else
  {
    echo "$HEADING"
    echo
    cat -
    echo
  } >> "$PRD"
fi

echo "$PRD"
