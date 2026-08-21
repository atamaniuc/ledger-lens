#!/usr/bin/env bash
set -euo pipefail

# Regenerates src/platform/supabase/database.types.ts from the local stack's schema.
#
# Local rather than the hosted project on purpose: the two carry the same
# migrations, and generating from local keeps this reproducible offline and
# without credentials. With --check it regenerates into a temp file and
# fails if the committed one differs, which is what makes the types a gate
# rather than a file someone remembers to refresh.

cd "$(dirname "$0")/.."

OUT="src/platform/supabase/database.types.ts"
HEADER="// Generated from the local Supabase schema — do not edit by hand.
// Regenerate with \`task types\` after any migration; \`task types-check\`
// (part of \`task verify\`) fails when this file and the schema disagree.
"

generate() {
  printf '%s\n' "$HEADER"
  supabase gen types typescript --local --schema public
}

if ! supabase status >/dev/null 2>&1; then
  echo "the local stack is not running — start it with 'task dev-start'" >&2
  exit 1
fi

if [ "${1:-}" = "--check" ]; then
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' EXIT
  generate > "$tmp"
  if ! diff -q "$OUT" "$tmp" >/dev/null 2>&1; then
    echo "$OUT is out of date with the schema. Run 'task types'." >&2
    diff -u "$OUT" "$tmp" | head -40 >&2 || true
    exit 1
  fi
  echo "$OUT matches the schema."
else
  generate > "$OUT"
  echo "wrote $OUT"
fi
