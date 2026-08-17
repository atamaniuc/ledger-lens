#!/usr/bin/env bash
# Create an isolated git worktree for one parallel OMC agent, per CLAUDE.md
# "Parallel Execution: Git Worktrees". One branch, one worktree, one agent.
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $(basename "$0") <stage-N-short-desc> [base-branch]" >&2
  exit 1
fi

BRANCH="$1"
BASE="${2:-}"

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "Not inside a git repository." >&2
  exit 1
}
cd "$REPO_ROOT"

if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
  echo "Repo has no commits yet — git worktree needs a base commit to branch from." >&2
  echo "Make an initial commit on the default branch first, then retry." >&2
  exit 1
fi

if [ -z "$BASE" ]; then
  BASE="$(git symbolic-ref --short HEAD 2>/dev/null || echo main)"
fi

WT_DIR="$REPO_ROOT/.worktrees/$BRANCH"

if git rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
  echo "Branch '$BRANCH' already exists — attaching worktree to it (not creating fresh)." >&2
  git worktree add "$WT_DIR" "$BRANCH"
else
  git worktree add -b "$BRANCH" "$WT_DIR" "$BASE"
fi

echo "$WT_DIR"
echo "Branch: $BRANCH (from $BASE)" >&2
echo "Reminder: migration-touching tasks stay sequential across worktrees — see CLAUDE.md." >&2
