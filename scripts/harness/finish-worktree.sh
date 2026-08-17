#!/usr/bin/env bash
# Clean up a worktree after its branch has been merged/PR'd. Merge itself is
# NOT done here — that's superpowers:finishing-a-development-branch's job.
# This script only ever removes a *clean* worktree; never force-discards work.
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $(basename "$0") <stage-N-short-desc>" >&2
  exit 1
fi

BRANCH="$1"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "Not inside a git repository." >&2
  exit 1
}
WT_DIR="$REPO_ROOT/.worktrees/$BRANCH"

if [ ! -d "$WT_DIR" ]; then
  echo "No worktree at $WT_DIR" >&2
  exit 1
fi

if [ -n "$(git -C "$WT_DIR" status --porcelain)" ]; then
  echo "Worktree $WT_DIR has uncommitted changes — commit, stash, or discard manually first. Not removing." >&2
  exit 1
fi

git worktree remove "$WT_DIR"
echo "Removed worktree: $WT_DIR"
echo "Branch '$BRANCH' still exists locally — delete it yourself once merged, this script won't." >&2
