#!/usr/bin/env bash
# Generates the Postman environment for the local stack.
#
# The environment is generated rather than committed because it holds the
# local stack's service_role and anon keys. Those keys are fixed, publicly
# documented development values that grant nothing outside this machine —
# but a committed file holding a key named "service_role" is a habit worth
# not forming, and one day the file gets copied and filled in with a real
# one. The template beside it is what's in git.
#
# Usage: scripts/postman-env.sh    (or: make postman-env)

set -euo pipefail
cd "$(dirname "$0")/.."

OUT=postman/LedgerLens.local.postman_environment.json

[ -f .env.local ] || { echo ".env.local not found — see docs/LOCAL_DEV.md" >&2; exit 1; }
set -a; . ./.env.local; set +a

command -v supabase >/dev/null || { echo "supabase CLI not found" >&2; exit 1; }
STATUS=$(supabase status -o json) || { echo "local stack not running — supabase start" >&2; exit 1; }

python3 - "$OUT" "$STATUS" <<'PY'
import json, os, sys

out, status = sys.argv[1], json.loads(sys.argv[2])

def var(key, value, secret=False):
    return {"key": key, "value": value, "type": "secret" if secret else "default", "enabled": True}

env = {
    "name": "LedgerLens — local",
    "values": [
        var("baseUrl", "http://localhost:3000"),
        var("supabaseUrl", status["API_URL"]),
        var("anonKey", status["ANON_KEY"], secret=True),
        var("serviceRoleKey", status["SERVICE_ROLE_KEY"], secret=True),
        var("ingestionSecret", os.environ.get("INGESTION_TRIGGER_SECRET", ""), secret=True),
        # Fixed by supabase/seed.sql so requests can hardcode them.
        var("orgA", "00000000-0000-4000-8000-000000000001"),
        var("orgB", "00000000-0000-4000-8000-000000000002"),
        var("bobEmail", "bob@globex.test"),
        var("bobPassword", "password123", secret=True),
    ],
    "_postman_variable_scope": "environment",
}

with open(out, "w") as f:
    json.dump(env, f, indent=2)
    f.write("\n")
print(f"wrote {out}")
PY
