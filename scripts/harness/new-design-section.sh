#!/usr/bin/env bash
# Append (or replace) a "## <feature>" section in .claude/DESIGN.md per
# CLAUDE.md Phase 1 step 3 — approved architecture, written after
# /superpowers:brainstorming has converged on one approach.
#
# See also: .omc/skills/design/SKILL.md — this script only scaffolds the
# section shape below; the skill teaches how to fill it in (one clear
# purpose per component, PRD/ADR cross-links, don't write it before
# brainstorming has actually converged). Skeleton and skill are kept in
# sync deliberately — if you change one, change the other.
#
# Same two modes as new-prd-section.sh:
#   - Interactive/no stdin: empty Overview/Components/Data Flow/Error
#     Handling/Testing Plan/Open Questions skeleton.
#   - Piped stdin: writes the piped content verbatim as the section body.
#
# Known limitation (flagged by a Codex review pass, not yet fixed — not
# worth locking for): no file lock around the read-modify-write. Two
# concurrent invocations against the same DESIGN.md can race and lose an
# update. Fine at today's solo/sequential usage; revisit with a proper
# lock (mkdir-based or flock) before this script is ever called from
# truly parallel worktree agents writing the same file.
#
# Unlike ADR (one immutable file per decision), DESIGN.md is a living
# per-feature doc — --force here means "scope drifted, update the design
# in place" (CLAUDE.md Definition of Done item 5), not "the old design is
# forgotten." If the change is really an architecture reversal, not a
# refinement, it still needs its own ADR — see the `adr` skill.
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
  $(basename "$0") --force "Mock Provider" <<< "\$body"   # update in place
  some-agent-output | $(basename "$0") --force "Mock Provider"
EOF
  exit 1
fi

FEATURE="${ARGS[0]}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DESIGN="$REPO_ROOT/.claude/DESIGN.md"
HEADING="## ${FEATURE}"

mkdir -p "$(dirname "$DESIGN")"
if [ ! -f "$DESIGN" ]; then
  echo "# LedgerLens — Approved Architecture" > "$DESIGN"
  echo >> "$DESIGN"
fi

EXISTS=0
if grep -qxF "$HEADING" "$DESIGN"; then
  EXISTS=1
fi

if [ "$EXISTS" -eq 1 ] && [ "$FORCE" -ne 1 ]; then
  echo "Section '$HEADING' already exists in $DESIGN — not duplicating. Use --force to update it." >&2
  exit 1
fi

if [ "$EXISTS" -eq 1 ] && [ "$FORCE" -eq 1 ]; then
  awk -v heading="$HEADING" '
    $0 == heading { skip=1; next }
    skip && /^## / { skip=0 }
    !skip { print }
  ' "$DESIGN" > "$DESIGN.tmp"
  mv "$DESIGN.tmp" "$DESIGN"
fi

if [ -t 0 ]; then
  {
    echo "$HEADING"
    echo
    echo "**PRD:** link to the \`.claude/PRD.md\` section this satisfies."
    echo "**ADR(s):** link any ADR(s) that justify a non-obvious choice here."
    echo
    echo "**Overview:**"
    echo
    echo "**Components:** (one clear purpose each — what it does, how it's used, what it depends on)"
    echo
    echo "**Data flow:**"
    echo
    echo "**Error handling:**"
    echo
    echo "**Testing plan:**"
    echo
    echo "**Open questions / risks:**"
    echo
  } >> "$DESIGN"
else
  {
    echo "$HEADING"
    echo
    cat -
    echo
  } >> "$DESIGN"
fi

echo "$DESIGN"
