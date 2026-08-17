#!/usr/bin/env bash
# Append (or replace) a "## <feature>" section in .claude/PRD.md per CLAUDE.md
# Phase 0.
#
# See also: .omc/skills/prd/SKILL.md — this script only scaffolds the
# section shape below; the skill is what teaches how to write good content
# into it (real North Star/proxy/counter metrics, honestly prioritized
# P0/P1/P2 stories with binary acceptance criteria, an Out of Scope that
# actually bounds the work). Skeleton and skill are kept in sync
# deliberately — if you change one, change the other.
#
# Two modes:
#   - Interactive/no stdin: writes an empty skeleton matching the prd
#     skill's structure (Metadata / Context & Business Value / Success
#     Metrics / Functional Requirements / Non-Functional Requirements &
#     Constraints / User Flow & Design / Out of Scope) for you to fill in
#     by hand.
#   - Piped stdin: writes whatever you pipe in as the section body verbatim
#     (e.g. the `prd` skill's own output, or a heredoc). Useful for
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
    echo "**Status:** Draft"
    echo "**Participants:**"
    echo "**Timeline:**"
    echo
    echo "### Context & Business Value"
    echo
    echo "**Problem:**"
    echo
    echo "**Business goal:**"
    echo
    echo "**Target audience:**"
    echo
    echo "### Success Metrics"
    echo
    echo "**North Star metric:**"
    echo
    echo "**Proxy metrics:**"
    echo
    echo "**Counter-metrics:**"
    echo
    echo "### Functional Requirements"
    echo
    echo "| ID | User Story | Priority | Acceptance Criteria |"
    echo "|---|---|---|---|"
    echo "| | | | |"
    echo
    echo "### Non-Functional Requirements & Constraints"
    echo
    echo "### User Flow & Design"
    echo
    echo "### Out of Scope"
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
