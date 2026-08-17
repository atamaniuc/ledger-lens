#!/usr/bin/env bash
set -euo pipefail

# Proves provider-webhook end-to-end without the mock provider (Stage 1
# only exposes a pull API — see .claude/DESIGN.md's "Open questions /
# risks"). POSTs one valid event and one invalid event (null customer,
# triggers Zod's nullFields-style failure in lib/ingestion/transform.ts)
# against a locally-served function, documented as "how a real provider
# would call it."
#
# Prereqs:
#   supabase functions serve provider-webhook --env-file supabase/.env.local
#   (WEBHOOK_SHARED_SECRET must be set in that env file)
#
# Usage:
#   WEBHOOK_SHARED_SECRET=dev-secret ORG_ID=<uuid> ./simulate.sh

FUNCTION_URL="${FUNCTION_URL:-http://127.0.0.1:54321/functions/v1/provider-webhook}"
WEBHOOK_SHARED_SECRET="${WEBHOOK_SHARED_SECRET:?set WEBHOOK_SHARED_SECRET}"
ORG_ID="${ORG_ID:?set ORG_ID to an existing orgs.id}"

echo "== valid event =="
curl -sS -X POST "$FUNCTION_URL" \
  -H "content-type: application/json" \
  -H "x-webhook-secret: $WEBHOOK_SHARED_SECRET" \
  -d "{
    \"org_id\": \"$ORG_ID\",
    \"source\": \"mock-provider\",
    \"event\": {
      \"external_id\": \"inv-webhook-001\",
      \"customer\": \"Acme Corp\",
      \"amount\": 4999,
      \"currency\": \"USD\",
      \"status\": \"open\",
      \"issued_at\": \"2026-08-15\"
    }
  }" | tee /dev/stderr
echo

echo "== invalid event (null customer, quarantined not dropped) =="
curl -sS -X POST "$FUNCTION_URL" \
  -H "content-type: application/json" \
  -H "x-webhook-secret: $WEBHOOK_SHARED_SECRET" \
  -d "{
    \"org_id\": \"$ORG_ID\",
    \"source\": \"mock-provider\",
    \"event\": {
      \"external_id\": \"inv-webhook-002\",
      \"customer\": null,
      \"amount\": 1500,
      \"currency\": \"USD\",
      \"status\": \"open\",
      \"issued_at\": \"2026-08-15\"
    }
  }" | tee /dev/stderr
echo

echo "== auth failure (wrong secret, 401, nothing written) =="
curl -sS -o /dev/null -w "HTTP %{http_code}\n" -X POST "$FUNCTION_URL" \
  -H "content-type: application/json" \
  -H "x-webhook-secret: wrong-secret" \
  -d "{\"org_id\": \"$ORG_ID\", \"event\": {}}"
