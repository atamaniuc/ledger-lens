#!/bin/bash
set -euo pipefail

# HDD context surfacer (spec 0015 / D-61): prints specs/TRACKS.md plus the
# first 20 lines of each live track's handoff.md as SessionStart
# additionalContext, so a new session sees in-flight work without depending
# on the agent remembering AGENTS.md's "load its handoff first" rule.
#
# Read-only, no network, no writes — safe on startup/resume/clear/compact.

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
TRACKS="$ROOT/specs/TRACKS.md"

if [ ! -f "$TRACKS" ]; then
  exit 0
fi

ctx="== specs/TRACKS.md (live work tracks — HDD; AGENTS.md: load a track's handoff before starting on it) ==
$(cat "$TRACKS")
"

while IFS= read -r handoff_rel; do
  [ -z "$handoff_rel" ] && continue
  handoff_path="$ROOT/$handoff_rel"
  if [ -f "$handoff_path" ]; then
    ctx="$ctx
== $handoff_rel (first 20 lines) ==
$(head -n 20 "$handoff_path")
"
  fi
done < <(grep -oE 'specs/[A-Za-z0-9_.-]+/handoff\.md' "$TRACKS" | sort -u)

jq -n --arg ctx "$ctx" '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}'
