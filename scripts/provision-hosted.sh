#!/usr/bin/env bash
# Provision the HOSTED project with the demo tenants and users.
#
# The hosted database is schema-only: migrations carry tables and functions,
# but the seed (supabase/seed.sql) is a local-stack step and never touches a
# hosted project. A deployed app with no orgs and no users looks broken even
# when it is not — so this script creates exactly what supabase/seed.sql
# creates locally, through the hosted project's own APIs.
#
# Why a script instead of an automatic step in the deploy: it needs the
# hosted project's real anon and service-role keys, which live in the
# Supabase dashboard (Project Settings > API) and are not available to
# Pulumi or CI. It is idempotent — run it as often as you like.
#
# Usage: SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=<key> ./scripts/provision-hosted.sh

set -euo pipefail

URL="${SUPABASE_URL:?SUPABASE_URL must be the hosted project URL (https://<ref>.supabase.co)}"
KEY="${SUPABASE_SERVICE_ROLE_KEY:?SUPABASE_SERVICE_ROLE_KEY must be the hosted project's service-role key}"

api() { # method path body?
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -fsS -X "$method" "$URL$path" \
      -H "apikey: $KEY" -H "authorization: Bearer $KEY" \
      -H "content-type: application/json" -d "$body"
  else
    curl -fsS -X "$method" "$URL$path" \
      -H "apikey: $KEY" -H "authorization: Bearer $KEY" \
      -H "content-type: application/json"
  fi
}

ORG_A="00000000-0000-4000-8000-000000000001"
ORG_B="00000000-0000-4000-8000-000000000002"
ALICE="00000000-0000-4000-9000-000000000001"
BOB="00000000-0000-4000-9000-000000000002"

echo "provisioning ${URL} (idempotent)..."
api POST /rest/v1/orgs "{\"id\":\"$ORG_A\",\"name\":\"Acme Corp\"}" || echo "  orgs: Acme already present (fine)"
api POST /rest/v1/orgs "{\"id\":\"$ORG_B\",\"name\":\"Globex Inc\"}" || echo "  orgs: Globex already present (fine)"

echo "  users (via Auth admin API)..."
api POST /auth/v1/admin/users "{\"email\":\"alice@acme.test\",\"password\":\"password123\",\"email_confirm\":true}" || echo "  alice exists (fine)"
api POST /auth/v1/admin/users "{\"email\":\"bob@globex.test\",\"password\":\"password123\",\"email_confirm\":true}" || echo "  bob exists (fine)"

echo "  memberships..."
api POST /rest/v1/memberships "{\"user_id\":\"$ALICE\",\"org_id\":\"$ORG_A\",\"role\":\"admin\"}" || echo "  alice membership exists (fine)"
api POST /rest/v1/memberships "{\"user_id\":\"$BOB\",\"org_id\":\"$ORG_B\",\"role\":\"member\"}" || echo "  bob membership exists (fine)"

echo "done. Sign in at ${URL} with alice@acme.test / bob@globex.test (password: password123)."
echo "Invoices and the corpus are not provisioned here — point the mock provider"
echo "at the deployed app and run an ingestion pass (docs/RUNBOOK.md)."
