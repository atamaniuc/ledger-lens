#!/usr/bin/env bash
# Local end-to-end smoke tests, one section per roadmap stage.
#
# `bun test` covers pure functions; this covers the thing unit tests
# cannot — the running app talking to a running Postgres over HTTP. Run it
# after every stage, per docs/LOCAL_DEV.md.
#
# Usage:
#   scripts/smoke.sh          # every implemented stage
#   scripts/smoke.sh 1        # mock provider only (no database needed)
#   scripts/smoke.sh 2        # ingestion only (needs the local stack up)
#   scripts/smoke.sh 3        # data quality checks only
#
# Requires: the Next.js dev server (bun run dev), the local Supabase stack
# (supabase start), and .env.local — see docs/LOCAL_DEV.md.

set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
DB_URL="${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"

# Fixed tenant UUIDs from supabase/seed.sql.
ORG_A="00000000-0000-4000-8000-000000000001"  # Acme Corp
ORG_B="00000000-0000-4000-8000-000000000002"  # Globex Inc
BOB="00000000-0000-4000-9000-000000000002"    # bob@globex.test, member of Globex only

pass=0; fail=0
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; fail=$((fail+1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# Loads .env.local so INGESTION_TRIGGER_SECRET does not have to be exported
# by hand. Same file the dev server reads, so the two can never disagree.
if [ -f .env.local ]; then
  set -a; . ./.env.local; set +a
fi

require_server() {
  if ! curl -fsS -o /dev/null "$BASE_URL/api/mock-provider/summary" 2>/dev/null; then
    echo "Dev server not reachable at $BASE_URL — start it with: bun run dev" >&2
    exit 1
  fi
}

# --- Stage 1: Mock Provider ------------------------------------------------
# Each chaos flag is asserted in isolation (every other flag off) so a
# failure names one failure mode rather than "something in the provider".

# All seven chaos flags off, except the ones named. The route reads each
# flag with searchParams.get(), which returns the FIRST occurrence — so a
# flag cannot be re-enabled by appending it to an all-off string, it has to
# be left out of that string entirely.
flags_off_except() {
  local keep=" $* " name out=""
  for name in duplicates schemaDrift nullFields rateLimit serverError expiredToken futureDates; do
    case "$keep" in *" $name "*) continue ;; esac
    out="$out&$name=false"
  done
  printf '%s' "${out#&}"
}

stage1() {
  head_ "Stage 1 — Mock Provider"
  local off; off=$(flags_off_except)

  local summary
  summary=$(curl -fsS "$BASE_URL/api/mock-provider/summary" 2>/dev/null)
  if [ -n "$summary" ] && [ "$(jq -r '.total_amount_cents // "null"' <<<"$summary")" != "null" ]; then
    ok "/summary returns a total ($(jq -r .total_amount_cents <<<"$summary") cents, $(jq -r .invoice_count <<<"$summary") invoices)"
  else
    bad "/summary" "$summary"
  fi

  local page
  page=$(curl -fsS "$BASE_URL/api/mock-provider/invoices?$off" 2>/dev/null)
  if [ "$(jq -r '.data | length' <<<"$page" 2>/dev/null)" -gt 0 ] 2>/dev/null; then
    ok "/invoices returns a page ($(jq -r '.data|length' <<<"$page") records, next_cursor=$(jq -r .next_cursor <<<"$page"))"
  else
    bad "/invoices" "$page"
  fi

  # Cursor pagination walks the whole dataset and terminates.
  #
  # `failed` is tracked separately from `cursor` on purpose. A request that
  # errors leaves the cursor exactly as it was, so a failure on the first
  # page leaves it empty — indistinguishable from a clean walk to the end,
  # and the assertion would pass without a single page having been fetched.
  local cursor total pages failed
  cursor=""; total=0; pages=0; failed=""
  while [ $pages -lt 50 ]; do
    local url="$BASE_URL/api/mock-provider/invoices?$off"
    [ -n "$cursor" ] && url="$url&cursor=$cursor"
    local p
    if ! p=$(curl -fsS "$url" 2>/dev/null); then
      failed="request failed at page $((pages + 1)) (cursor=${cursor:-none})"
      break
    fi
    total=$(( total + $(jq -r '.data|length' <<<"$p") ))
    pages=$((pages+1))
    cursor=$(jq -r '.next_cursor // empty' <<<"$p")
    [ -z "$cursor" ] && break
  done
  if [ -n "$failed" ]; then
    bad "cursor pagination terminates" "$failed"
  elif [ -n "$cursor" ]; then
    bad "cursor pagination terminates" "still had a cursor after $pages pages"
  elif [ "$pages" -eq 0 ]; then
    bad "cursor pagination terminates" "walked zero pages"
  else
    ok "cursor pagination terminates ($total records over $pages pages)"
  fi

  # schemaDrift: the provider starts emitting amount as a string mid-stream.
  local drift
  drift=$(curl -fsS "$BASE_URL/api/mock-provider/invoices?$(flags_off_except schemaDrift)&schemaDrift=true&cursor=100" 2>/dev/null)
  if [ "$(jq '[.data[] | select(.amount | type == "string")] | length' <<<"$drift" 2>/dev/null)" -gt 0 ] 2>/dev/null; then
    ok "schemaDrift emits string amounts"
  else
    bad "schemaDrift" "no string amounts in the drifted page"
  fi

  # rateLimit fires on every 10th request, so 10 requests must produce one.
  local got429=0 i code
  for i in $(seq 1 10); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/api/mock-provider/invoices?$(flags_off_except rateLimit)&rateLimit=true")
    [ "$code" = "429" ] && got429=1 && break
  done
  [ $got429 = 1 ] && ok "rateLimit returns 429" || bad "rateLimit" "no 429 in 10 requests"

  # serverError fires on every 25th request.
  local got500=0
  for i in $(seq 1 25); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/api/mock-provider/invoices?$(flags_off_except serverError)&serverError=true")
    [ "$code" = "500" ] && got500=1 && break
  done
  [ $got500 = 1 ] && ok "serverError returns 500" || bad "serverError" "no 500 in 25 requests"

  # expiredToken counts per token string: a fresh token dies after 15 uses.
  local tok got401=0
  tok="smoke-$RANDOM-$RANDOM"
  for i in $(seq 1 17); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $tok" \
      "$BASE_URL/api/mock-provider/invoices?$(flags_off_except expiredToken)&expiredToken=true")
    [ "$code" = "401" ] && got401=1 && break
  done
  [ $got401 = 1 ] && ok "expiredToken returns 401 after 15 requests on one token" \
                  || bad "expiredToken" "no 401 in 17 requests"
}

# --- Stage 2: Ingestion & Transform ---------------------------------------

psql_q() { psql "$DB_URL" -tAc "$1" 2>/dev/null; }

# This script destroys data (see the truncate in stage2). It may only ever
# talk to a database on this machine.
#
# The host is parsed out and matched exactly rather than looked for as a
# substring. A substring test is the tempting version and it is wrong in
# both directions: `postgresql://user:pw@db.example.com/x?opt=127.0.0.1`
# would pass it, and so would the host `127.0.0.1.attacker.example`.
# Anything that is not a recognisable postgres URL is refused rather than
# guessed at — libpq accepts key/value connection strings too, and this
# check has no business trying to parse those.
require_local_db() {
  local rest hostport host

  case "$DB_URL" in
    postgres://*|postgresql://*) ;;
    *) reject_db_url "not a postgres:// or postgresql:// URL" ;;
  esac

  rest=${DB_URL#*://}     # drop the scheme
  rest=${rest%%/*}        # drop /dbname and anything after it
  rest=${rest%%\?*}       # drop ?params when there is no path
  hostport=${rest##*@}    # drop userinfo; the last @ separates it

  case "$hostport" in
    # Bracketed IPv6 literal: the host ends at the closing bracket, so the
    # port has to be stripped there and not at the first colon.
    \[*) host=${hostport%%\]*}; host=${host#\[} ;;
    *)   host=${hostport%%:*} ;;
  esac

  case "$host" in
    127.0.0.1|localhost|::1) return 0 ;;
    *) reject_db_url "host '$host' is not loopback" ;;
  esac
}

reject_db_url() {
  echo "Refusing to run: $1." >&2
  echo "  DB_URL=$DB_URL" >&2
  echo "This script truncates the pipeline tables and is for the local stack only." >&2
  exit 3
}

# Runs one query as a real end user: the `authenticated` role with a JWT
# claim, which is exactly what PostgREST sets up and what every RLS policy
# keys off via auth.uid(). `set local` needs the explicit transaction, and
# only the last line of output is the result — the SET commands echo too.
as_user() {
  psql "$DB_URL" -tAq <<SQL 2>/dev/null | tail -1
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"$1","role":"authenticated"}';
$2;
rollback;
SQL
}

ingest() {  # ingest <org_id> -> response body
  curl -sS -X POST "$BASE_URL/api/ingestion/run" \
    -H 'content-type: application/json' \
    -H "x-ingestion-secret: ${INGESTION_TRIGGER_SECRET:-}" \
    -d "{\"org_id\":\"$1\"}"
}

stage2() {
  head_ "Stage 2 — Ingestion & Transform"

  # Checked before the connection is even attempted: the refusal must not
  # depend on whether the wrong database happened to answer.
  require_local_db

  if ! psql_q 'select 1' >/dev/null; then
    bad "local database reachable" "$DB_URL — is the stack up? (supabase start)"
    return
  fi
  ok "local database reachable"

  # Start from empty pipeline state. Several assertions below are about what
  # a first run does (how many rows it writes, how many it quarantines), and
  # a run resuming from a previous smoke run's cursor reads nothing at all —
  # which would fail them for a reason that has nothing to do with the code.
  # Only the pipeline tables are cleared; the seeded orgs and users stay, so
  # this never depends on a full `supabase db reset`.
  #
  # Guarded on the host, not on the default. DB_URL is overridable, and the
  # obvious way to "check the hosted project quickly" is to point it there —
  # at which point this line silently destroys real data. Loopback only, and
  # refuse rather than skip: a smoke run that quietly did not reset would
  # report failures that look like code defects.
  psql_q "truncate table quarantine, invoices, raw_events, pipeline_runs restart identity cascade" >/dev/null

  if [ -z "${INGESTION_TRIGGER_SECRET:-}" ]; then
    bad "INGESTION_TRIGGER_SECRET set" "missing from .env.local"
    return
  fi

  # Auth: the route writes with the service role and takes org_id from the
  # body, so an unauthenticated caller must not get past the door.
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/api/ingestion/run" \
    -H 'content-type: application/json' -d "{\"org_id\":\"$ORG_A\"}")
  [ "$code" = "401" ] && ok "unauthenticated trigger rejected (401)" \
                      || bad "unauthenticated trigger rejected" "got $code"

  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/api/ingestion/run" \
    -H 'content-type: application/json' -H "x-ingestion-secret: $INGESTION_TRIGGER_SECRET" \
    -d '{"org_id":"not-a-uuid"}')
  [ "$code" = "400" ] && ok "non-uuid org_id rejected (400)" || bad "non-uuid org_id rejected" "got $code"

  local r1; r1=$(ingest "$ORG_A")
  if [ "$(jq -r '.status // "null"' <<<"$r1")" = "succeeded" ]; then
    ok "run 1 succeeded (read=$(jq -r .rows_read <<<"$r1") written=$(jq -r .rows_written <<<"$r1") quarantined=$(jq -r .rows_quarantined <<<"$r1") deduped=$(jq -r .rows_deduplicated <<<"$r1"))"
  else
    bad "run 1 succeeded" "$r1"; return
  fi

  # The PRD's "zero silent drops" counter-metric, checked rather than asserted.
  [ "$(jq -r .counters_balanced <<<"$r1")" = "true" ] \
    && ok "counters balance (read = written + quarantined + deduplicated)" \
    || bad "counters balance" "$r1"

  # Quarantine is supposed to be non-empty: the provider injects null
  # customers. An empty quarantine means validation stopped rejecting.
  [ "$(jq -r .rows_quarantined <<<"$r1")" -gt 0 ] \
    && ok "invalid records quarantined, not dropped" \
    || bad "invalid records quarantined" "rows_quarantined = 0 — is nullFields chaos still on?"

  # US-03 idempotency: replay from cursor 0 must write nothing new.
  psql_q "update pipeline_runs set cursor_to = null where org_id = '$ORG_A' and kind = 'incremental'" >/dev/null
  local before after r2
  before=$(psql_q "select count(*) from invoices where org_id = '$ORG_A'")
  r2=$(ingest "$ORG_A")
  after=$(psql_q "select count(*) from invoices where org_id = '$ORG_A'")
  if [ "$before" = "$after" ] && [ "$(jq -r .rows_deduplicated <<<"$r2")" -gt 0 ]; then
    ok "re-ingest is idempotent (invoices stayed at $after, $(jq -r .rows_deduplicated <<<"$r2") deduplicated)"
  else
    bad "re-ingest is idempotent" "invoices $before -> $after; $r2"
  fi

  # The Stage 2 review's CRITICAL finding: the idempotency key must be
  # tenant-scoped, or org B's identical external_ids vanish silently.
  local rb; rb=$(ingest "$ORG_B")
  if [ "$(jq -r '.rows_written // 0' <<<"$rb")" -gt 0 ]; then
    ok "second tenant ingests the same external_ids ($(jq -r .rows_written <<<"$rb") written for Globex)"
  else
    bad "second tenant ingests the same external_ids" "$rb"
  fi

  # Privilege convergence. The grants migration revokes the Data API roles
  # down to least privilege so a project created under the legacy
  # "auto-expose new entities" default ends up identical to a current one.
  # anon holding INSERT/UPDATE/DELETE is currently harmless (RLS denies what
  # no policy allows) but it is exactly the state that turns one forgotten
  # `enable row level security` into a public write endpoint.
  local anon_privs
  anon_privs=$(psql_q "select count(*) from information_schema.role_table_grants
    where table_schema = 'public' and grantee = 'anon'")
  [ "$anon_privs" = "0" ] && ok "anon holds no privileges on public tables" \
                          || bad "anon holds no privileges" "$anon_privs grants remain"

  local wide
  wide=$(psql_q "select count(*) from information_schema.role_table_grants
    where table_schema = 'public' and grantee in ('authenticated','service_role')
      and privilege_type in ('DELETE','TRUNCATE')")
  [ "$wide" = "0" ] && ok "no DELETE or TRUNCATE granted to any Data API role" \
                    || bad "no DELETE or TRUNCATE granted" "$wide such grants remain"

  # No orphans: every raw event has a downstream invoice or quarantine row.
  local orphans
  orphans=$(psql_q "select count(*) from raw_events r
    where not exists (select 1 from invoices i where i.raw_event_id = r.id)
      and not exists (select 1 from quarantine q where q.raw_event_id = r.id)")
  [ "$orphans" = "0" ] && ok "no orphaned raw_events" || bad "no orphaned raw_events" "$orphans orphans"

  # RLS, as a real authenticated user rather than the service role.
  #
  # Both directions are asserted. The negative alone is not evidence: a
  # query that returns zero because the role switch failed, or because the
  # table is empty, looks identical to one that returns zero because RLS
  # works. The positive control is what rules those out.
  local leaked own
  leaked=$(as_user "$BOB" "select count(*) from invoices where org_id = '$ORG_A'")
  own=$(as_user "$BOB"    "select count(*) from invoices where org_id = '$ORG_B'")
  if [ "$leaked" = "0" ] && [ "${own:-0}" -gt 0 ] 2>/dev/null; then
    ok "RLS: Globex's user sees its own $own invoices and zero of Acme's"
  elif [ "$leaked" != "0" ]; then
    bad "RLS: non-member sees zero rows" "saw $leaked Acme invoices as Globex's user"
  else
    bad "RLS positive control" "Globex's user sees $own of its own invoices — expected > 0"
  fi
}

# --- Stage 3: Data Quality & Reconciliation -------------------------------

dq() {  # dq <org_id> [run_id] -> response body
  local body
  if [ -n "${2:-}" ]; then body="{\"org_id\":\"$1\",\"run_id\":\"$2\"}"
  else body="{\"org_id\":\"$1\"}"; fi
  curl -sS -X POST "$BASE_URL/api/data-quality/run" \
    -H 'content-type: application/json' \
    -H "x-ingestion-secret: ${INGESTION_TRIGGER_SECRET:-}" \
    -d "$body"
}

# Runs the checks inside a transaction that mutates state first, then rolls
# back. Asserting that a check *can* fail matters as much as asserting it
# passes: a check that cannot go red is decoration.
dq_what_if() {  # dq_what_if <setup sql> <check_name> -> status
  psql "$DB_URL" -tAq <<SQL 2>/dev/null | tail -1
begin;
$1;
select status from public.run_data_quality_checks(
  '$ORG_A', (select id from public.pipeline_runs
              where org_id = '$ORG_A' and kind = 'incremental'
              order by started_at desc limit 1),
  $PROVIDER_TOTAL, $PROVIDER_COUNT)
 where check_name = '$2';
rollback;
SQL
}

stage3() {
  head_ "Stage 3 — Data Quality & Reconciliation"

  require_local_db
  if ! psql_q 'select 1' >/dev/null; then
    bad "local database reachable" "$DB_URL"; return
  fi
  if [ -z "${INGESTION_TRIGGER_SECRET:-}" ]; then
    bad "INGESTION_TRIGGER_SECRET set" "missing from .env.local"; return
  fi

  local summary
  summary=$(curl -fsS "$BASE_URL/api/mock-provider/summary" 2>/dev/null)
  PROVIDER_TOTAL=$(jq -r .total_amount_cents <<<"$summary")
  PROVIDER_COUNT=$(jq -r .invoice_count <<<"$summary")

  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/api/data-quality/run" \
    -H 'content-type: application/json' -d "{\"org_id\":\"$ORG_A\"}")
  [ "$code" = "401" ] && ok "unauthenticated check trigger rejected (401)" \
                      || bad "unauthenticated check trigger rejected" "got $code"

  # US-05: every run gets a verdict, without a scheduler.
  psql_q "update pipeline_runs set cursor_to = null where org_id = '$ORG_A' and kind = 'incremental'" >/dev/null
  local run
  run=$(curl -sS -X POST "$BASE_URL/api/ingestion/run" -H 'content-type: application/json' \
    -H "x-ingestion-secret: $INGESTION_TRIGGER_SECRET" -d "{\"org_id\":\"$ORG_A\"}")
  local overall complete
  overall=$(jq -r '.data_quality.overall // "missing"' <<<"$run")
  complete=$(jq -r '.data_quality.complete // false' <<<"$run")
  [ "$overall" != "missing" ] && ok "an ingestion run carries a data-quality verdict ($overall)" \
                              || bad "ingestion run carries a verdict" "$run"
  [ "$complete" = "true" ] && ok "all four checks ran, not a partial set" \
                           || bad "all four checks ran" "complete=$complete"

  # US-04, the headline number: every cent the provider reported is either
  # invoiced or accounted for in quarantine. Not "close enough" — zero.
  local recon drift unacc
  recon=$(jq -r '.data_quality.results[] | select(.check_name=="reconciliation")' <<<"$run")
  drift=$(jq -r '.delta' <<<"$recon")
  unacc=$(jq -r '.details.unaccounted_rows' <<<"$recon")
  if [ "$drift" = "0" ] && [ "$unacc" = "0" ]; then
    ok "reconciliation drift is exactly 0 (invoiced $(jq -r .details.invoiced_cents <<<"$recon") + quarantined $(jq -r .details.quarantined_cents <<<"$recon") = $(jq -r .expected <<<"$recon"))"
  else
    bad "reconciliation drift is exactly 0" "drift=$drift unaccounted=$unacc"
  fi

  # An idempotent re-run reads its usual batch and writes nothing. That is
  # the most normal thing this pipeline does, and it must not read as a
  # volume anomaly — measuring the baseline on rows_written made it one.
  psql_q "update pipeline_runs set cursor_to = null where org_id = '$ORG_A' and kind = 'incremental'" >/dev/null
  local rerun vol
  rerun=$(curl -sS -X POST "$BASE_URL/api/ingestion/run" -H 'content-type: application/json' \
    -H "x-ingestion-secret: $INGESTION_TRIGGER_SECRET" -d "{\"org_id\":\"$ORG_A\"}")
  vol=$(jq -r '.data_quality.results[] | select(.check_name=="volume") | .status' <<<"$rerun")
  # Asserted as an allow-list, not as "not fail". A missing verdict makes jq
  # print nothing, and an absent status is not a passing status — with a
  # negated test the check would go green precisely when it stopped running.
  if [ "$(jq -r .rows_written <<<"$rerun")" = "0" ] && { [ "$vol" = "pass" ] || [ "$vol" = "warn" ]; }; then
    ok "a fully deduplicated re-run does not trip the volume check ($vol)"
  else
    bad "deduplicated re-run does not trip volume" "written=$(jq -r .rows_written <<<"$rerun") volume=$vol"
  fi

  # Ad-hoc invocation with no run: there is no batch to size, so volume must
  # abstain rather than report the absent run as a zero-row batch.
  local adhoc
  adhoc=$(dq "$ORG_A")
  local adhocVol adhocReason
  adhocVol=$(jq -r '.results[] | select(.check_name=="volume") | .status' <<<"$adhoc")
  adhocReason=$(jq -r '.results[] | select(.check_name=="volume") | .details.reason // ""' <<<"$adhoc")
  if { [ "$adhocVol" = "pass" ] || [ "$adhocVol" = "warn" ]; } && [ "$adhocReason" = "no_run_context" ]; then
    ok "checks without a run_id abstain on volume rather than failing"
  else
    bad "checks without a run_id abstain on volume" "status=$adhocVol reason=$adhocReason"
  fi

  # Each check must be able to go red. Asserted against mutations that are
  # rolled back, so the database is unchanged afterwards.
  [ "$(dq_what_if "update raw_events set ingested_at = now() - interval '25 hours' where org_id = '$ORG_A'" freshness)" = "fail" ] \
    && ok "freshness fails on 25-hour-old data" || bad "freshness fails on stale data" "stayed green"

  [ "$(dq_what_if "insert into quarantine (org_id, raw_event_id, run_id, reason) select '$ORG_A', null, id, 'simulated' from pipeline_runs where org_id='$ORG_A' order by started_at desc limit 1" reconciliation)" = "fail" ] \
    && ok "reconciliation fails on a record whose value cannot be located" \
    || bad "reconciliation fails on an unaccounted record" "stayed green"

  [ "$(dq_what_if "delete from invoices where id in (select id from invoices where org_id='$ORG_A' limit 5)" reconciliation)" = "fail" ] \
    && ok "reconciliation fails when value actually goes missing" \
    || bad "reconciliation fails on real loss" "stayed green"

  # A quarantined payload whose amount is JSON null: `payload ? 'amount'` is
  # true, the cast yields NULL, and sum() skips it — so the value went
  # missing while the check reported zero unaccounted rows, pointing its
  # reader at the wrong place.
  [ "$(dq_what_if "update raw_events set payload = jsonb_set(payload,'{amount}','null')
        where id = (select raw_event_id from quarantine
                     where org_id='$ORG_A' and raw_event_id is not null limit 1)" reconciliation)" = "fail" ] \
    && ok "a null amount in a quarantined payload is counted as unaccounted" \
    || bad "null amount counted as unaccounted" "stayed green"

  # A non-numeric amount used to raise `invalid input syntax for type
  # numeric` and take the whole quality run down. Corrupt payloads are what
  # this pipeline exists to receive; one must not be able to disable the
  # check that would report it.
  [ "$(dq_what_if "update raw_events set payload = jsonb_set(payload,'{amount}','\"not-a-number\"')
        where id = (select raw_event_id from quarantine
                     where org_id='$ORG_A' and raw_event_id is not null limit 1)" reconciliation)" = "fail" ] \
    && ok "a non-numeric amount is reported, not fatal to the whole check" \
    || bad "non-numeric amount survives the check" "the check raised or stayed green"

  local rid
  rid=$(psql_q "select id from pipeline_runs where org_id = '$ORG_A' and kind='incremental' order by started_at desc limit 1")
  # The baseline needs three prior succeeded runs before volume will judge
  # anything, so they are synthesised inside the same rolled-back
  # transaction. Without them this assertion silently measured
  # insufficient_history and passed for the wrong reason.
  [ "$(dq_what_if "insert into pipeline_runs (org_id, source, kind, status, started_at, finished_at, rows_read)
        select '$ORG_A', 'mock-provider', 'incremental', 'succeeded', now() - interval '1 day', now() - interval '1 day', 207
          from generate_series(1,3);
       update pipeline_runs set rows_read = 20 where id = '$rid'" volume)" = "fail" ] \
    && ok "volume fails on a batch 90% below a three-run baseline" \
    || bad "volume fails on a small batch" "stayed green"

  # And the boundary holds: exactly at the edge of the tolerated band is
  # still a pass, so the check is not quietly one-sided.
  [ "$(dq_what_if "insert into pipeline_runs (org_id, source, kind, status, started_at, finished_at, rows_read)
        select '$ORG_A', 'mock-provider', 'incremental', 'succeeded', now() - interval '1 day', now() - interval '1 day', 207
          from generate_series(1,3);
       update pipeline_runs set rows_read = 104 where id = '$rid'" volume)" = "pass" ] \
    && ok "volume tolerates a batch just inside the -50% band" \
    || bad "volume tolerates the -50% boundary" "went red inside the tolerated band"

  # Cross-tenant: attributing one org's results to another must raise, not
  # quietly scope to the wrong tenant.
  local crossed
  crossed=$(psql "$DB_URL" -tAc "select 1 from public.run_data_quality_checks('$ORG_B', '$rid', $PROVIDER_TOTAL, $PROVIDER_COUNT)" 2>&1 | head -1)
  case "$crossed" in
    *"does not belong to org"*) ok "a run_id from another org is rejected, not silently rescoped" ;;
    *) bad "cross-org run_id rejected" "$crossed" ;;
  esac

  # RLS on the new table, same standard as every other.
  local leaked own
  leaked=$(as_user "$BOB" "select count(*) from data_quality_results where org_id = '$ORG_A'")
  own=$(as_user "$BOB"    "select count(*) from data_quality_results where org_id = '$ORG_B'")
  if [ "$leaked" = "0" ]; then
    ok "RLS: Globex's user sees zero of Acme's quality results (its own: ${own:-0})"
  else
    bad "RLS on data_quality_results" "saw $leaked rows of the other tenant"
  fi
}

# --- main ------------------------------------------------------------------

require_server
case "${1:-all}" in
  1) stage1 ;;
  2) stage2 ;;
  3) stage3 ;;
  all) stage1; stage2; stage3 ;;
  *) echo "unknown stage: $1 (expected 1, 2, 3, or all)" >&2; exit 2 ;;
esac

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
