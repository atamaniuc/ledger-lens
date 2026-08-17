-- Fixes found by the Stage 2 review pass (CLAUDE.md Definition of Done
-- item 3). See .claude/DESIGN.md's "Ingestion & Transform" section.

-- 1. Tenant-scoped idempotency key.
--
-- The original constraint omitted org_id, so a second tenant ingesting the
-- same external_id from the same source hit ON CONFLICT DO NOTHING and was
-- silently discarded — no invoices row, no quarantine row, no error, run
-- reported as succeeded. That breaks the PRD's "zero silent drops"
-- counter-metric and makes Stage 7's org-isolation test pass vacuously
-- (org B would have no data to isolate).
alter table raw_events
  drop constraint raw_events_source_external_id_event_version_key;

alter table raw_events
  add constraint raw_events_org_source_external_id_event_version_key
  unique (org_id, source, external_id, event_version);

-- 2. Run bookkeeping the counters can actually be checked against.
--
-- rows_read counted every record while rows_written/rows_quarantined only
-- counted records that produced a row, so deduplicated records vanished
-- from the arithmetic and rows_read - written - quarantined != 0 was the
-- normal state. With rows_deduplicated the identity
--   rows_read = rows_written + rows_quarantined + rows_deduplicated
-- holds exactly, which turns "every raw record ends up somewhere" from an
-- assertion into a checkable invariant.
alter table pipeline_runs
  add column rows_deduplicated int not null default 0;

-- CLAUDE.md: "Every log line: correlation_id". Storing it on the run row
-- ties a run's log lines to its persisted record.
alter table pipeline_runs
  add column correlation_id text;

-- 3. The push path needs its own kind. Webhook runs previously wrote
-- kind='incremental' with a null cursor_to under the same (org_id, source),
-- so a single webhook delivery became the newest 'succeeded' run and reset
-- the polling path's cursor resume to offset 0.
alter table pipeline_runs
  drop constraint pipeline_runs_kind_check;

alter table pipeline_runs
  add constraint pipeline_runs_kind_check
  check (kind in ('incremental','full','backfill','webhook'));

-- 4. Atomic single-record ingest.
--
-- The raw_events insert and its invoices/quarantine counterpart used to be
-- two separate round-trips. A failure between them left a raw_events row
-- with no downstream row, and because idempotency was keyed on "does a
-- raw_events row exist", the retry that should have healed the gap was the
-- thing that permanently closed it — reported as a successful duplicate.
--
-- Doing both writes inside one function makes them one transaction: any
-- error rolls back the raw_events row too, so an orphan cannot be created.
-- The conflict path additionally checks for a downstream row and heals an
-- orphan left by an earlier (pre-fix) run instead of skipping it.
--
-- Validation stays in TypeScript (lib/ingestion/transform.ts, shared by
-- both paths per ADR 0002) — this function receives an already-decided
-- outcome, it does not re-implement the Zod schema in SQL.
--
-- Superseded immediately by 20260817143416, which adds `set search_path`
-- (security advisor: function_search_path_mutable). Kept here so this
-- file matches what was actually applied, in order.
create or replace function public.ingest_raw_event(
  p_org_id            uuid,
  p_source            text,
  p_external_id       text,
  p_event_version     text,
  p_payload           jsonb,
  p_payload_hash      text,
  p_run_id            uuid,
  p_pipeline_version  text,
  p_customer          text,
  p_amount_cents      bigint,
  p_currency          text,
  p_status            text,
  p_issued_at         date,
  p_quarantine_reason text,
  p_quarantine_details jsonb
)
returns table (outcome text, raw_event_id bigint)
language plpgsql
-- SECURITY INVOKER (the default): callers are the pipeline's own
-- service-role client, which already bypasses RLS. A definer-rights
-- function would add an RLS-bypassing surface for no benefit.
as $$
declare
  v_raw_id bigint;
  v_has_downstream boolean;
begin
  insert into raw_events (
    org_id, source, external_id, event_version, payload, payload_hash, run_id
  )
  values (
    p_org_id, p_source, p_external_id, p_event_version,
    p_payload, p_payload_hash, p_run_id
  )
  on conflict (org_id, source, external_id, event_version) do nothing
  returning id into v_raw_id;

  if v_raw_id is null then
    select id into v_raw_id
      from raw_events
     where org_id = p_org_id
       and source = p_source
       and external_id = p_external_id
       and event_version = p_event_version;

    select exists (select 1 from invoices   where invoices.raw_event_id   = v_raw_id)
        or exists (select 1 from quarantine where quarantine.raw_event_id = v_raw_id)
      into v_has_downstream;

    if v_has_downstream then
      return query select 'duplicate'::text, v_raw_id;
      return;
    end if;
    -- Orphan: raw event present, no downstream row. Fall through and
    -- write the downstream row rather than skipping it.
  end if;

  if p_quarantine_reason is not null then
    insert into quarantine (org_id, raw_event_id, run_id, reason, details)
    values (p_org_id, v_raw_id, p_run_id, p_quarantine_reason, p_quarantine_details);
    return query select 'quarantined'::text, v_raw_id;
    return;
  end if;

  insert into invoices (
    org_id, external_id, customer, amount_cents, currency, status,
    issued_at, raw_event_id, run_id, pipeline_version
  )
  values (
    p_org_id, p_external_id, p_customer, p_amount_cents, p_currency, p_status,
    p_issued_at, v_raw_id, p_run_id, p_pipeline_version
  );
  return query select 'written'::text, v_raw_id;
end;
$$;

-- Not a public API surface: only the pipeline's service-role client calls
-- this. anon/authenticated reach the data through RLS-scoped SELECTs.
revoke execute on function public.ingest_raw_event(
  uuid, text, text, text, jsonb, text, uuid, text,
  text, bigint, text, text, date, text, jsonb
) from public, anon, authenticated;
