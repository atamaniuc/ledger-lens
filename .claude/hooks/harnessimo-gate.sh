#!/usr/bin/env sh
# Blocks the end of a turn while `harnessimo check` is red, and hands the
# report back to the agent rather than to a log nobody reads.
#
# Written by `harnessimo hooks install --agent`. Edit it freely — it is a
# normal file in the repository, and nothing here rewrites it without --force.
set -e
cd "${CLAUDE_PROJECT_DIR:-.}"

# The turn is already continuing because this hook blocked it once.
# Blocking again is a loop, and a loop is how a gate gets deleted.
input=$(cat)
case "$input" in
  *'"stop_hook_active":true'*|*'"stop_hook_active": true'*) exit 0 ;;
esac

if [ -x node_modules/.bin/harnessimo ]; then
  HARNESSIMO="node_modules/.bin/harnessimo"
elif [ -f src/cli.ts ]; then
  HARNESSIMO="node src/cli.ts"
elif [ -f bin/harnessimo.mjs ]; then
  HARNESSIMO="node bin/harnessimo.mjs"
elif command -v harnessimo >/dev/null 2>&1; then
  HARNESSIMO="harnessimo"
else
  # No CLI, no gate — and no noise at the end of every turn either.
  exit 0
fi

if report=$($HARNESSIMO check 2>&1); then
  exit 0
fi

# Exit code 2 is the one an agent is shown; the report goes with it, so the
# next thing it reads is the file, the line and the fix.
{ echo "$report"; echo; echo "harnessimo: this turn cannot end while a check is red."; } >&2
exit 2
