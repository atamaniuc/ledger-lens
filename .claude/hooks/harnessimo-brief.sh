#!/usr/bin/env sh
# Prints the harness state as SessionStart additionalContext.
# Written by `harnessimo hooks install --agent`. Read-only: no writes,
# no network, safe on startup, resume, clear and compact.
set -e
cd "${CLAUDE_PROJECT_DIR:-.}"
if [ -x node_modules/.bin/harnessimo ]; then
  exec node_modules/.bin/harnessimo brief --json
elif [ -f bin/harnessimo.mjs ]; then
  exec node bin/harnessimo.mjs brief --json
elif command -v harnessimo >/dev/null 2>&1; then
  exec harnessimo brief --json
fi
# No CLI, no context — and no noise on startup either.
exit 0
