-- Spec 0011 (lane W4-K): observability — metrics and alerts in Postgres.
-- Closes D-45 (no metrics, no traces, no alerting).
--
-- Design, stated plainly:
--
--  * The four metrics are SQL views, not in-process counters. The app is
--    serverless: a counter in memory dies with the instance, and a counter
--    that dies with the instance is not a metric. Each view is a single
--    query a human can run ("select * from public.freshness_lag where
--    org_id = '<uuid>'"), each has documented units and a documented
--    window, and each is created with security_invoker = true so the
--    caller's RLS on the base tables decides what comes back — a user sees
--    their own org's row or nothing, never another tenant's numbers
--    (DoD #4). Views are not checked by tests/rls-coverage.spec.ts (it
--    walks pg_class relkind = 'r'), but the RLS of the tables beneath them
--    is the same RLS those tests pin down.
--
--  * Alerts are rows, not vendor-side rules. pg_cron already exists
--    (migration 20260821110000) and is the only scheduler this project has;
--    a new job evaluates the two thresholds against the views and writes
--    into public.observability_alerts. An alert row is the
--    machine-verifiable artifact: open while the condition holds (re-fires
--    refresh observed/last_seen_at rather than stacking), resolved when it
--    clears. Routing that row to a channel (email/Slack) is deliberately
--    out of scope here — see the lane report for the pg_net path — because
--    an alert nobody can machine-verify is a feature nobody can test.
--
--  * Thresholds are a table, not constants in this file: an operator edits
--    a row, no migration needed, and every alert row records the threshold
--    it fired against, so a threshold change is versioned in the rows it
--    produced. The seeded defaults match the boundaries the pipeline
--    already enforces: freshness 4h sits between the quality check's 2h
--    pass and 24h fail (migration 20260818103000), and the $10/day cost cap
--    is the same number check_agent_budget enforces (migration
--    20260821100000), so the alert fires exactly when the budget starts
--    refusing requests.

-- ---------------------------------------------------------------------------
-- 1. observability_alerts - the alert artifact.
-- ---------------------------------------------------------------------------

create table public.observability_alerts (
  id           bigint generated always as identity primary key,
  org_id       uuid not null references orgs(id) on delete cascade,
  alert_name   text not null
               check (alert_name in ('freshness_exceeded','daily_cost_exceeded')),
  severity     text not null default 'warning'
               check (severity in ('warning','critical')),
  status       text not null default 'open'
               check (status in ('open','resolved')),
  -- The values at fire time (refreshed on re-fire), so the row says which
  -- threshold version it fired against.
  observed     numeric not null,
  threshold    numeric not null,
  unit         text not null,
  details      jsonb,
  opened_at    timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at  timestamptz
);

create index observability_alerts_org_idx
  on public.observability_alerts (org_id, status);
-- The monitor's own hot path: which open alerts exist per org.
create index observability_alerts_open_idx
  on public.observability_alerts (status) where status = 'open';

-- RLS on the same migration that creates the table, per CLAUDE.md and the
-- D-30 coverage test. Read-own-org only; nobody but the monitor function
-- (which runs as the table owner, postgres, via pg_cron) writes.
alter table public.observability_alerts enable row level security;

create policy "read own org observability_alerts" on public.observability_alerts
for select to authenticated
using (
  org_id in (select org_id from memberships where user_id = (select auth.uid()))
);

-- Explicit grants, per 20260818094500: revoke the Data API roles to
-- nothing, then grant back only the verbs each uses. The function below
-- writes as postgres (the cron role), so no Data API role holds INSERT.
revoke all on table public.observability_alerts
  from anon, authenticated, service_role;
revoke all on sequence public.observability_alerts_id_seq
  from anon, authenticated, service_role;

grant select on table public.observability_alerts to authenticated;
grant select on table public.observability_alerts to service_role;

-- ---------------------------------------------------------------------------
-- 2. observability_alert_thresholds - versioned, operator-editable.
-- ---------------------------------------------------------------------------

create table public.observability_alert_thresholds (
  alert_name text primary key
             check (alert_name in ('freshness_exceeded','daily_cost_exceeded')),
  threshold  numeric not null check (threshold > 0),
  unit       text not null,
  updated_at timestamptz not null default now()
);

insert into public.observability_alert_thresholds (alert_name, threshold, unit) values
  ('freshness_exceeded',  14400, 'seconds'),    -- 4h; the pipeline polls every 15m (spec 0003)
  ('daily_cost_exceeded', 1000,  'usd_cents')   -- $10/day, the same cap check_agent_budget enforces (spec 0002)
on conflict (alert_name) do nothing;

-- Global config, not org data: no row can be attributed to a tenant, so
-- there is no org-scoped policy to write — RLS on with no policies denies
-- every non-owner, and only the monitor (postgres) and service_role read
-- it. A future dashboard feature that wants to display thresholds grants
-- SELECT to authenticated with a `using (true)` policy.
alter table public.observability_alert_thresholds enable row level security;

revoke all on table public.observability_alert_thresholds
  from anon, authenticated, service_role;
grant select on table public.observability_alert_thresholds to service_role;

-- ---------------------------------------------------------------------------
-- 3. The four metrics, one view each. Units and windows are named in the
--    column comments; each view is one query a human can run.
-- ---------------------------------------------------------------------------

-- freshness_lag: newest invoice vs now, per org. Seconds; an org with no
-- invoices has no row (no data is not staleness — same stance as the
-- quality check's no_data -> warn).
create view public.freshness_lag
with (security_invoker = true) as
select
  org_id,
  max(transformed_at) as newest_invoice_at,
  round(extract(epoch from (now() - max(transformed_at)))::numeric, 2) as lag_seconds,
  now() as measured_at
from public.invoices
group by org_id;

-- ingest_error_rate: failed runs over total in the trailing 24h window,
-- per org. Percent; null when the org has no runs in the window.
create view public.ingest_error_rate
with (security_invoker = true) as
select
  org_id,
  count(*) filter (where status = 'failed') as failed_runs,
  count(*) as total_runs,
  case when count(*) = 0 then null
       else round((count(*) filter (where status = 'failed'))::numeric
                  / count(*) * 100, 2)
  end as error_rate_pct,
  now() - interval '24 hours' as window_start,
  now() as window_end
from public.pipeline_runs
where started_at >= now() - interval '24 hours'
group by org_id;

-- agent_p95_latency: p95 of llm_calls.latency_ms over the trailing 7 days,
-- per org. Milliseconds.
create view public.agent_p95_latency
with (security_invoker = true) as
select
  org_id,
  count(*) as calls,
  round(percentile_cont(0.95) within group (order by latency_ms)::numeric, 2)
    as p95_latency_ms,
  now() - interval '7 days' as window_start,
  now() as window_end
from public.llm_calls
where latency_ms is not null
  and created_at >= now() - interval '7 days'
group by org_id;

-- llm_daily_cost: spend per org per UTC day, from llm_calls.cost_cents.
-- Cents (numeric(12,4) semantics, like the column it sums).
create view public.llm_daily_cost
with (security_invoker = true) as
select
  org_id,
  date_trunc('day', created_at) as day,
  round(sum(cost_cents), 4) as cost_cents,
  count(*) as calls
from public.llm_calls
where cost_cents is not null
group by org_id, date_trunc('day', created_at);

-- Same discipline as 20260818094500: a fresh view inherits the platform's
-- default ACL (TRUNCATE, REFERENCES, TRIGGER for the Data API roles — the
-- rls-coverage spec asserts authenticated holds SELECT only), so revoke
-- first, then grant only the read verbs each role uses.
revoke all on table
  public.freshness_lag,
  public.ingest_error_rate,
  public.agent_p95_latency,
  public.llm_daily_cost
from anon, authenticated, service_role;

grant select on
  public.freshness_lag,
  public.ingest_error_rate,
  public.agent_p95_latency,
  public.llm_daily_cost
to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. The monitor: evaluate_observability_alerts - one evaluation pass.
-- ---------------------------------------------------------------------------
-- Fires (opens or refreshes) an alert for every org whose metric exceeds
-- the threshold, then resolves every open alert whose condition has
-- cleared. Idempotent by construction: an already-open alert is refreshed,
-- never duplicated; a resolved alert stays resolved until the condition
-- fires again. The cron job below just calls this; a human can call it the
-- same way. It reads through the views (as postgres, the owner, so RLS
-- does not hide any tenant's numbers from the monitor).

create or replace function public.open_or_update_alert(
  p_org_id     uuid,
  p_alert_name text,
  p_observed   numeric,
  p_threshold  numeric,
  p_unit       text,
  p_details    jsonb
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.observability_alerts a
     where a.org_id = p_org_id
       and a.alert_name = p_alert_name
       and a.status = 'open'
  ) then
    update public.observability_alerts
       set observed = p_observed,
           threshold = p_threshold,
           details = p_details,
           last_seen_at = now()
     where org_id = p_org_id
       and alert_name = p_alert_name
       and status = 'open';
  else
    insert into public.observability_alerts
      (org_id, alert_name, observed, threshold, unit, details)
    values (p_org_id, p_alert_name, p_observed, p_threshold, p_unit, p_details);
  end if;
end;
$$;

create or replace function public.evaluate_observability_alerts()
returns table (
  org_id     uuid,
  alert_name text,
  status     text,
  observed   numeric,
  threshold  numeric
)
language plpgsql
set search_path = ''
as $$
declare
  v_alert record;
begin
  -- 1. Fire: freshness beyond its threshold.
  for v_alert in
    select fl.org_id, fl.newest_invoice_at, fl.lag_seconds as observed,
           t.threshold, t.unit
      from public.freshness_lag fl
      join public.observability_alert_thresholds t
        on t.alert_name = 'freshness_exceeded'
     where fl.lag_seconds > t.threshold
  loop
    perform public.open_or_update_alert(
      v_alert.org_id,
      'freshness_exceeded',
      v_alert.observed,
      v_alert.threshold,
      v_alert.unit,
      jsonb_build_object('newest_invoice_at', v_alert.newest_invoice_at)
    );
  end loop;

  -- 2. Fire: today's spend over the cap.
  for v_alert in
    select c.org_id, c.cost_cents as observed, t.threshold, t.unit
      from public.llm_daily_cost c
      join public.observability_alert_thresholds t
        on t.alert_name = 'daily_cost_exceeded'
     where c.day = date_trunc('day', now())
       and c.cost_cents > t.threshold
  loop
    perform public.open_or_update_alert(
      v_alert.org_id,
      'daily_cost_exceeded',
      v_alert.observed,
      v_alert.threshold,
      v_alert.unit,
      jsonb_build_object('day', to_char(
        date_trunc('day', now()) AT TIME ZONE 'UTC', 'YYYY-MM-DD'))
    );
  end loop;

  -- 3. Resolve: every open alert whose condition no longer holds.
  update public.observability_alerts a
     set status = 'resolved', resolved_at = now()
   where a.status = 'open'
     and (
       (a.alert_name = 'freshness_exceeded' and not exists (
          select 1 from public.freshness_lag fl
           where fl.org_id = a.org_id
             and fl.lag_seconds > (
               select t.threshold from public.observability_alert_thresholds t
                where t.alert_name = 'freshness_exceeded'
             )
       ))
       or
       (a.alert_name = 'daily_cost_exceeded' and not exists (
          select 1 from public.llm_daily_cost c
           where c.org_id = a.org_id
             and c.day = date_trunc('day', now())
             and c.cost_cents > (
               select t.threshold from public.observability_alert_thresholds t
                where t.alert_name = 'daily_cost_exceeded'
             )
       ))
     );

  -- 4. The monitor's answer: what is open right now.
  return query
    select a.org_id, a.alert_name, a.status::text, a.observed, a.threshold
      from public.observability_alerts a
     where a.status = 'open'
     order by a.org_id, a.alert_name;
end;
$$;

-- Not a public API surface: only the cron job (as postgres) calls this.
-- service_role keeps EXECUTE so an operator can trigger an evaluation
-- between cron fires; authenticated cannot.
revoke execute on function public.evaluate_observability_alerts()
  from public, anon, authenticated;
grant execute on function public.evaluate_observability_alerts()
  to service_role;

revoke execute on function public.open_or_update_alert(
  uuid, text, numeric, numeric, text, jsonb
) from public, anon, authenticated;
grant execute on function public.open_or_update_alert(
  uuid, text, numeric, numeric, text, jsonb
) to service_role;

-- ---------------------------------------------------------------------------
-- 5. The cron job (AC-03: the alert fires without a vendor). Idempotently
--    created, same unschedule-then-schedule pattern as 20260821110000.
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from cron.job where jobname = 'll_obs_alerts') then
    perform cron.unschedule('ll_obs_alerts');
  end if;
  perform cron.schedule_in_database(
    'll_obs_alerts',
    '*/5 * * * *',
    $cron$select public.evaluate_observability_alerts();$cron$,
    'postgres'
  );
end;
$$;
