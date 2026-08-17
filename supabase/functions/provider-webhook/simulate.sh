#!/usr/bin/env bash
set -euo pipefail

# Proves provider-webhook end-to-end without the mock provider (Stage 1
# only exposes a pull API — see .claude/DESIGN.md's "Open questions /
# risks"). Asserts, rather than just printing: this is the gate that backs
# DESIGN's testing-plan item "proving actual code reuse, not just similar
# behavior", so it exits non-zero when an outcome doesn't match.
#
# Cases, in order:
#   1. valid event            -> succeeded  (invoices row)
#   2. same event redelivered -> duplicate  (US-03 idempotency, no new row)
#   3. null customer          -> quarantined (US-04, never dropped)
#   4. wrong secret           -> 401, nothing written
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

# Fresh external_id per invocation, so case 1 is genuinely new and case 2 is
# genuinely a redelivery of it — a fixed id would make case 1 report
# "duplicate" on the second run of this script.
RUN_TAG="$(date +%s)"
FAILURES=0

post() {
  local secret="$1" payload="$2"
  curl -sS -o /tmp/webhook-body.$$ -w '%{http_code}' -X POST "$FUNCTION_URL" \
    -H "content-type: application/json" \
    -H "x-webhook-secret: $secret" \
    -d "$payload"
}

expect() {
  local label="$1" want_status="$2" want_fragment="$3" got_status="$4"
  local body
  body="$(cat /tmp/webhook-body.$$)"
  if [ "$got_status" != "$want_status" ] || ! grep -q "$want_fragment" <<<"$body"; then
    echo "FAIL  $label"
    echo "      want HTTP $want_status containing '$want_fragment'"
    echo "      got  HTTP $got_status: $body"
    FAILURES=$((FAILURES + 1))
  else
    echo "PASS  $label  ($body)"
  fi
}

valid_event() {
  cat <<EOF
{
  "org_id": "$ORG_ID",
  "source": "mock-provider",
  "event": {
    "external_id": "inv-webhook-$RUN_TAG",
    "customer": "Acme Corp",
    "amount": 4999,
    "currency": "USD",
    "status": "open",
    "issued_at": "2026-08-15"
  }
}
EOF
}

invalid_event() {
  cat <<EOF
{
  "org_id": "$ORG_ID",
  "source": "mock-provider",
  "event": {
    "external_id": "inv-webhook-$RUN_TAG-bad",
    "customer": null,
    "amount": 1500,
    "currency": "USD",
    "status": "open",
    "issued_at": "2026-08-15"
  }
}
EOF
}

expect "valid event accepted"           200 '"status":"succeeded"'   "$(post "$WEBHOOK_SHARED_SECRET" "$(valid_event)")"
expect "redelivery deduplicated"        200 '"status":"duplicate"'   "$(post "$WEBHOOK_SHARED_SECRET" "$(valid_event)")"
expect "null customer quarantined"      200 '"status":"quarantined"' "$(post "$WEBHOOK_SHARED_SECRET" "$(invalid_event)")"
expect "wrong secret rejected"          401 'unauthorized'           "$(post "wrong-secret" "$(valid_event)")"

rm -f /tmp/webhook-body.$$

if [ "$FAILURES" -gt 0 ]; then
  echo
  echo "$FAILURES case(s) failed."
  exit 1
fi
echo
echo "All 4 cases passed."
