-- Stage 3 (Data Quality & Reconciliation): the results table, its RLS, and
-- the function that computes all four checks.
--
-- See .claude/DESIGN.md's "Data Quality & Reconciliation" section and
-- ADR 0005 for why the four checks share one function and why
-- reconciliation compares against accounted value rather than written
-- value.

create table data_quality_results (
  id         bigserial primary key,
  org_id     uuid not null references orgs(id) on delete cascade,
  run_id     uuid references pipeline_runs(id) on delete cascade,
  check_name text not null
             check (check_name in ('freshness','volume','uniqueness','reconciliation')),
  status     text not null check (status in ('pass','warn','fail')),
  -- Kept as numeric rather than bigint: three of the four checks measure
  -- cents or row counts, but `volume` compares against a mean.
  observed   numeric,
  expected   numeric,
  delta      numeric,
  details    jsonb,
  created_at timestamptz not null default now()
);

create index data_quality_results_org_id_idx on data_quality_results (org_id);
-- US-05: the dashboard drills into one run's checks, and reads the newest
-- row per (run_id, check_name) because results accumulate rather than
-- upsert.
create index data_quality_results_run_check_idx
  on data_quality_results (run_id, check_name, created_at desc);

alter table data_quality_results enable row level security;

create policy "read own org data_quality_results" on data_quality_results
for select to authenticated
using (
  org_id in (select org_id from memberships where user_id = (select auth.uid()))
);

-- Explicit grants, per 20260818094500: nothing is auto-exposed, and the
-- privilege set has to be stated rather than inherited from a project-level
-- default.
--
-- Revoke first, for the same reason that migration does. Postgres hands a
-- freshly created table the platform's default ACL, which here means
-- TRUNCATE, REFERENCES and TRIGGER for anon, authenticated and service_role
-- — TRUNCATE in particular is not subject to RLS. Granting without revoking
-- would leave this table wider than every Stage 2 table beside it. This is
-- not hypothetical: scripts/smoke.sh asserts that anon holds nothing, and
-- it failed on this table before this block existed.
revoke all on table public.data_quality_results
  from anon, authenticated, service_role;
revoke all on sequence public.data_quality_results_id_seq
  from anon, authenticated, service_role;

-- Read-only for the dashboard's user; insert for the pipeline. No delete,
-- no truncate: results are a log.
grant select on table public.data_quality_results to authenticated;
grant select, insert on table public.data_quality_results to service_role;
grant usage, select on sequence public.data_quality_results_id_seq to service_role;

-- ---------------------------------------------------------------------------
-- The four checks.
--
-- One function, one transaction: a partial result set (three rows written,
-- the fourth lost to an error) is indistinguishable from a run where the
-- fourth check was never configured. Provider numbers arrive as parameters
-- because Postgres does not make outbound HTTP requests here — the caller
-- fetches /summary and passes what it got (ADR 0005).

create or replace function public.run_data_quality_checks(
  p_org_id                 uuid,
  p_run_id                 uuid,
  p_provider_total_cents   bigint,
  p_provider_invoice_count integer
)
returns table (check_name text, status text, observed numeric, expected numeric, delta numeric, details jsonb)
language plpgsql
-- SECURITY INVOKER (the default): the only caller is the pipeline's
-- service-role client, which already bypasses RLS. Definer rights would add
-- an RLS-bypassing surface for no benefit.
set search_path = ''
as $$
declare
  -- Captured before any insert so the return can name this invocation's own
  -- rows. `order by id desc limit 4` would be wrong under concurrency: two
  -- runs checking the same org interleave their inserts, and each would
  -- return some of the other's results.
  v_first_id       bigint;
  v_last_ingest    timestamptz;
  v_age_seconds    numeric;
  v_status         text;
  v_details        jsonb;
  v_rows_written   integer;
  v_baseline_runs  integer;
  v_baseline_mean  numeric;
  v_deviation_pct  numeric;
  v_dupe_count     integer;
  v_semantic_dupes integer;
  v_invoiced       bigint;
  v_quarantined    bigint;
  v_unaccounted    integer;
  v_accounted      bigint;
  v_drift          bigint;
  v_drift_pct      numeric;
begin
  -- The run must belong to the org. Without this the caller could attribute
  -- one tenant's quality results to another by passing a foreign run_id —
  -- CLAUDE.md's "no cross-org_id query without an explicit filter" applies
  -- to the join key, not only to the where clause.
  select coalesce(max(id), 0) into v_first_id from public.data_quality_results;

  if p_run_id is not null and not exists (
    select 1 from public.pipeline_runs r
     where r.id = p_run_id and r.org_id = p_org_id
  ) then
    raise exception 'run % does not belong to org %', p_run_id, p_org_id
      using errcode = 'check_violation';
  end if;

  -- ---------------------------------------------------------------- US-01
  -- Freshness. No data at all is reported as `warn`, not `fail`: an org that
  -- has never ingested is not stale, and the PRD's counter-metric forbids a
  -- false positive on a healthy run.
  select max(ingested_at) into v_last_ingest
    from public.raw_events where org_id = p_org_id;

  if v_last_ingest is null then
    v_status := 'warn';
    v_age_seconds := null;
    v_details := jsonb_build_object('reason', 'no_data');
  else
    v_age_seconds := extract(epoch from (now() - v_last_ingest));
    v_status := case
      when v_age_seconds < 7200  then 'pass'    -- < 2h
      when v_age_seconds < 86400 then 'warn'    -- < 24h
      else 'fail'
    end;
    v_details := jsonb_build_object('last_ingested_at', v_last_ingest);
  end if;

  insert into public.data_quality_results
    (org_id, run_id, check_name, status, observed, expected, delta, details)
  values
    (p_org_id, p_run_id, 'freshness', v_status, v_age_seconds, 7200,
     case when v_age_seconds is null then null else v_age_seconds - 7200 end, v_details);

  -- ---------------------------------------------------------------- US-02
  -- Volume, against the trailing 7-day mean for the same org across
  -- succeeded runs, excluding this one.
  --
  -- Measured on rows_read, not rows_written. This check asks "did an
  -- unexpectedly small or large batch arrive from upstream", and a run that
  -- reads its usual 207 records and deduplicates every one of them is a
  -- healthy idempotent re-run, not a volume anomaly — but it writes zero,
  -- so a rows_written baseline reports it as -100% and fails. That is the
  -- false positive the PRD's counter-metric forbids, and it would fire on
  -- the most normal thing this pipeline does.
  select r.rows_read into v_rows_written
    from public.pipeline_runs r where r.id = p_run_id;
  v_rows_written := coalesce(v_rows_written, 0);

  select count(*), avg(r.rows_read)
    into v_baseline_runs, v_baseline_mean
    from public.pipeline_runs r
   where r.org_id = p_org_id
     and r.status = 'succeeded'
     and r.started_at >= now() - interval '7 days'
     and (p_run_id is null or r.id <> p_run_id);

  if p_run_id is null then
    -- Without a run there is no batch to size. Reporting the absent run as
    -- a zero-row batch made every ad-hoc invocation of these checks fail
    -- volume against a perfectly healthy baseline.
    v_status := 'pass';
    v_deviation_pct := null;
    v_details := jsonb_build_object('reason', 'no_run_context');
  elsif v_baseline_runs < 3 then
    -- A fresh database is healthy. Warning about a baseline that does not
    -- exist yet would be exactly the false positive the PRD forbids.
    v_status := 'pass';
    v_deviation_pct := null;
    v_details := jsonb_build_object(
      'reason', 'insufficient_history',
      'baseline_runs', v_baseline_runs);
  elsif coalesce(v_baseline_mean, 0) = 0 then
    v_status := case when v_rows_written = 0 then 'pass' else 'warn' end;
    v_deviation_pct := null;
    v_details := jsonb_build_object(
      'reason', 'baseline_mean_zero',
      'baseline_runs', v_baseline_runs);
  else
    v_deviation_pct := ((v_rows_written - v_baseline_mean) / v_baseline_mean) * 100;
    v_status := case
      when abs(v_deviation_pct) <= 50 then 'pass'
      when abs(v_deviation_pct) <= 80 then 'warn'
      else 'fail'
    end;
    v_details := jsonb_build_object(
      'baseline_runs', v_baseline_runs,
      'deviation_pct', round(v_deviation_pct, 2));
  end if;

  insert into public.data_quality_results
    (org_id, run_id, check_name, status, observed, expected, delta, details)
  values
    (p_org_id, p_run_id, 'volume', v_status,
     case when p_run_id is null then null else v_rows_written end,
     round(coalesce(v_baseline_mean, 0), 2),
     case when p_run_id is null or v_baseline_mean is null
          then null else v_rows_written - v_baseline_mean end,
     v_details);

  -- ---------------------------------------------------------------- US-03
  -- Uniqueness. Tautological while `invoices` carries its
  -- unique (org_id, external_id) constraint — deliberately kept so that a
  -- migration dropping the constraint does not also silently drop its
  -- verification (ADR 0005). The semantic-duplicate count in `details` is
  -- the non-tautological observation: same customer, amount and issue date
  -- under different external_ids, which idempotency by construction cannot
  -- catch. It is reported, not enforced.
  select count(*) into v_dupe_count from (
    select 1 from public.invoices
     where org_id = p_org_id
     group by external_id having count(*) > 1
  ) d;

  select count(*) into v_semantic_dupes from (
    select 1 from public.invoices
     where org_id = p_org_id
     group by customer, amount_cents, issued_at having count(*) > 1
  ) sd;

  insert into public.data_quality_results
    (org_id, run_id, check_name, status, observed, expected, delta, details)
  values
    (p_org_id, p_run_id, 'uniqueness',
     case when v_dupe_count = 0 then 'pass' else 'fail' end,
     v_dupe_count, 0, v_dupe_count,
     jsonb_build_object('semantic_duplicate_groups', v_semantic_dupes));

  -- ---------------------------------------------------------------- US-04
  -- Reconciliation against the provider's independent total.
  --
  -- Compared against *accounted* value, not written value: every cent the
  -- provider reported must be traceable either to an invoice or to a
  -- quarantined record whose original payload still carries the amount.
  -- Comparing against sum(invoices) alone reports an ~8.5% shortfall on a
  -- healthy pipeline, because quarantining corrupt records is correct
  -- behaviour rather than loss. See ADR 0005 for the measured numbers.
  select coalesce(sum(amount_cents), 0) into v_invoiced
    from public.invoices where org_id = p_org_id;

  -- The amount is parsed defensively, not cast directly. Two reasons, both
  -- observed rather than imagined:
  --
  --   * A direct `(payload->>'amount')::numeric` raises
  --     `invalid input syntax for type numeric` on a non-numeric value and
  --     takes the entire quality run down with it. Corrupt payloads are
  --     precisely what this pipeline is built to receive, so one of them
  --     must not be able to disable the check that would report it.
  --   * `payload ? 'amount'` is true for `"amount": null`. The cast then
  --     yields NULL, sum() skips it silently, and the record contributes
  --     nothing while still being reported as accounted for. The check went
  --     red — correctly — but named zero unaccounted rows, sending its
  --     reader to look for the missing value in the wrong place.
  --
  -- Anything that does not parse as a number is counted as unaccounted,
  -- which is what it is: value whose whereabouts cannot be established.
  select
      coalesce(sum(round(amt * 100)), 0),
      count(*) filter (where amt is null)
    into v_quarantined, v_unaccounted
    from (
      select case
               when q.raw_event_id is null then null
               when r.payload->>'amount' ~ '^\s*-?\d+(\.\d+)?([eE][+-]?\d+)?\s*$'
                 then (r.payload->>'amount')::numeric
               else null
             end as amt
        from public.quarantine q
        left join public.raw_events r on r.id = q.raw_event_id
       where q.org_id = p_org_id
    ) parsed;

  v_accounted := v_invoiced + v_quarantined;
  v_drift     := v_accounted - p_provider_total_cents;
  v_drift_pct := case
    when p_provider_total_cents = 0 then null
    else (v_drift::numeric / p_provider_total_cents) * 100
  end;

  -- An unaccounted row is a record whose value cannot be located at all —
  -- precisely what this check exists to surface — so it fails regardless of
  -- what the arithmetic happens to come to.
  v_status := case
    when v_unaccounted > 0 then 'fail'
    when v_drift = 0 then 'pass'
    when abs(coalesce(v_drift_pct, 100)) <= 0.5 then 'warn'
    else 'fail'
  end;

  insert into public.data_quality_results
    (org_id, run_id, check_name, status, observed, expected, delta, details)
  values
    (p_org_id, p_run_id, 'reconciliation', v_status,
     v_accounted, p_provider_total_cents, v_drift,
     jsonb_build_object(
       'invoiced_cents', v_invoiced,
       'quarantined_cents', v_quarantined,
       'unaccounted_rows', v_unaccounted,
       'drift_pct', case when v_drift_pct is null then null else round(v_drift_pct, 4) end,
       'provider_invoice_count', p_provider_invoice_count));

  return query
    select d.check_name, d.status, d.observed, d.expected, d.delta, d.details
      from public.data_quality_results d
     where d.id > v_first_id
       and d.org_id = p_org_id
     order by d.id;
end;
$$;

-- Not a public API surface: only the pipeline's service-role client calls
-- this. authenticated reads the results table through RLS instead.
revoke execute on function public.run_data_quality_checks(uuid, uuid, bigint, integer)
  from public, anon, authenticated;
grant execute on function public.run_data_quality_checks(uuid, uuid, bigint, integer)
  to service_role;
