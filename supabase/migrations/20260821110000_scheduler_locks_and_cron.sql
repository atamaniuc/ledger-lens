-- Spec 0003 (lane W2-B): pipeline scheduling and locks.
-- Closes D-11 (no scheduler), D-12 (no run locking), D-13 (webhook runs never
-- reaped), D-14 (corpus index built by hand), D-10 (the "Stage 4's cron"
-- comment promised a scheduler that did not exist).
--
-- Design, stated plainly:
--
--  * The three pg_cron jobs do NOT invoke the Next.js routes or the indexer
--    CLI directly. Postgres makes no outbound HTTP here: pg_net exists, but
--    the ingestion trigger requires a shared secret, and embedding that
--    secret in a migration (or in cron.job, where it would be readable) is
--    not acceptable. Instead each job enqueues a marker row into
--    public.scheduled_runs - "the marker/queue row that a run consumes"
--    (spec 0003). The polling route, operator tooling and the Python
--    indexer (spec 0005) consume those markers; a run marks its marker
--    done when it picks it up. The marker is the schedule's side effect and
--    its audit trail, and "select * from cron.job" shows all three jobs.
--
--  * The "one running run per org" invariant is enforced twice, because the
--    two mechanisms answer different races:
--      - a partial unique index on pipeline_runs(org_id) where status =
--        'running' is the race-proof backstop - no interleaving can produce
--        a second running row, whatever the callers do;
--      - public.try_start_polling_run additionally takes a transaction-
--        scoped advisory lock keyed on the org while it reads the resume
--        cursor and inserts the running row, so two overlapping *polling*
--        starts serialize on the cursor read (D-12's "cursor advances only
--        under the advisory lock") and the second is refused cleanly with a
--        reason instead of surfacing the index violation as a 500. The lock
--        is released when the RPC's transaction commits; the running row it
--        created is what guards the rest of the run's duration.
--
--  * Reap logic lives in exactly one SQL function, public.reap_abandoned_runs
--    (re-created here). The polling path calls it inside try_start_polling_run
--    on every start attempt - refused or not; the provider-webhook path
--    (lane W2-E) calls the same function directly before opening its run.
--
--  * The jobs target the seeded demo tenant (Acme Corp,
--    00000000-0000-4000-8000-000000000001). Multi-tenant deployments add
--    one job set per tenant; enqueue_scheduled_run takes org_id explicitly.

create extension if not exists pg_cron with schema cron;

-- ---------------------------------------------------------------------------
-- 1. scheduled_runs - the scheduler's marker/queue table.
-- ---------------------------------------------------------------------------

create table scheduled_runs (
  id           bigint generated always as identity primary key,
  org_id       uuid not null references orgs(id) on delete cascade,
  kind         text not null check (kind in ('ingest','quality','reindex')),
  status       text not null default 'pending'
               check (status in ('pending','done','failed')),
  -- The pipeline run that consumed this marker, when one has.
  run_id       uuid references pipeline_runs(id) on delete set null,
  error        text,
  requested_at timestamptz not null default now(),
  consumed_at  timestamptz
);

create index scheduled_runs_org_kind_idx on scheduled_runs (org_id, kind, requested_at);
-- A consumer looks for pending work first; the partial index keeps that
-- lookup over a table that accumulates history.
create index scheduled_runs_pending_idx on scheduled_runs (status) where status = 'pending';

-- RLS on the same migration that creates the table, per CLAUDE.md and the
-- D-30 coverage test: every public table must carry RLS and every
-- authenticated-readable table a policy.
alter table scheduled_runs enable row level security;

create policy "read own org scheduled_runs" on scheduled_runs
for select to authenticated
using (
  org_id in (select org_id from memberships where user_id = (select auth.uid()))
);

-- Grants follow 20260818094500's explicit model: revoke the Data API roles
-- to nothing, then grant back only the verbs each uses. authenticated reads
-- (its own org only, via the policy); service_role reads and writes so a
-- consumer can mark markers done - and holds no DELETE, matching the
-- coverage test's allowance (only chunks may be deleted).
revoke all on table public.scheduled_runs from anon, authenticated, service_role;
revoke all on sequence public.scheduled_runs_id_seq from anon, authenticated, service_role;

grant select on table public.scheduled_runs to authenticated;
grant select, insert, update on table public.scheduled_runs to service_role;
grant usage, select on sequence public.scheduled_runs_id_seq to service_role;

-- ---------------------------------------------------------------------------
-- 2. enqueue_scheduled_run - what every cron job's command calls.
-- ---------------------------------------------------------------------------
-- At-least-once + dedup (the project's stated delivery semantics): a fire
-- while the previous fire for the same (org, kind) is still pending returns
-- the existing marker instead of piling up duplicate work, so firing the
-- schedule twice is idempotent. Once a consumer marks a marker done, the
-- next fire enqueues a fresh one.

create or replace function public.enqueue_scheduled_run(
  p_org_id uuid,
  p_kind   text
)
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_id bigint;
begin
  if p_kind not in ('ingest', 'quality', 'reindex') then
    raise exception 'scheduled kind % is not one of ingest/quality/reindex', p_kind
      using errcode = 'check_violation';
  end if;

  select id into v_id
    from public.scheduled_runs
   where org_id = p_org_id and kind = p_kind and status = 'pending'
   order by id
   limit 1;

  if v_id is not null then
    return v_id;
  end if;

  insert into public.scheduled_runs (org_id, kind)
  values (p_org_id, p_kind)
  returning id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. reap_abandoned_runs - the single place reap logic lives (D-13).
-- ---------------------------------------------------------------------------
-- Re-created verbatim from 20260817144112 so this migration is the
-- authoritative home of the function both completion paths call. Exact
-- signature for lane W2-E (provider-webhook): call
--   public.reap_abandoned_runs(p_org_id uuid, p_source text,
--                              p_older_than interval DEFAULT '15 minutes')
-- before opening a webhook run, so a webhook run abandoned mid-flight is
-- reaped by the webhook path too, not only by polling.
-- Returns the number of runs reaped.

create or replace function public.reap_abandoned_runs(
  p_org_id uuid,
  p_source text,
  p_older_than interval default interval '15 minutes'
)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_reaped integer;
begin
  with reaped as (
    update public.pipeline_runs
       set status = 'failed',
           finished_at = now(),
           error = coalesce(error, 'abandoned: run never closed out, reaped')
     where org_id = p_org_id
       and source = p_source
       and status = 'running'
       and started_at < now() - p_older_than
    returning id
  )
  select count(*) into v_reaped from reaped;
  return v_reaped;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. At most one 'running' run per org - the race-proof backstop (D-12).
-- ---------------------------------------------------------------------------
-- No two rows for the same org can be 'running' at once, whichever path
-- (polling, webhook, cron-driven tooling) opens them. The advisory lock in
-- try_start_polling_run is what makes the *polling* refusal clean; this
-- index is what makes it true.

create unique index pipeline_runs_one_running_per_org
  on pipeline_runs (org_id)
  where status = 'running';

-- ---------------------------------------------------------------------------
-- 5. try_start_polling_run - reap + advisory lock + cursor read + open run,
--    in one transaction (D-12 T2, D-13 T3).
-- ---------------------------------------------------------------------------
-- Returns one row:
--   started         boolean  true when a run was opened
--   refused_reason  text     'advisory_lock_busy' | 'already_running' |
--                            'malformed' - null when started
--   run_id          uuid     the opened run, null when refused
--   cursor_from     text     the resume cursor, read under the lock
--   reaped          integer  how many abandoned runs were reaped first
--
-- Everything the polling route used to do in three round trips (reap RPC,
-- resume-cursor query, run insert) is now one atomic call, so the cursor
-- read and the running-row insert happen under the org's advisory lock.

create or replace function public.try_start_polling_run(
  p_org_id         uuid,
  p_source         text,
  p_correlation_id text
)
returns table (
  started        boolean,
  refused_reason text,
  run_id         uuid,
  cursor_from    text,
  reaped         integer
)
language plpgsql
set search_path = ''
as $$
declare
  v_reaped  integer;
  v_locked  boolean;
  v_running boolean;
  v_cursor  text;
  v_run_id  uuid;
begin
  -- 1. Reap first, on every start attempt (refused or not), so a stuck
  --    'running' row frees the one-running-per-org slot before the check
  --    below runs. Same function the webhook path calls - D-13.
  with reaped as (
    update public.pipeline_runs
       set status = 'failed',
           finished_at = now(),
           error = coalesce(error, 'abandoned: run never closed out, reaped')
     where org_id = p_org_id
       and source = p_source
       and status = 'running'
       and started_at < now() - interval '15 minutes'
    returning id
  )
  select count(*) into v_reaped from reaped;

  -- 2. One start at a time per org. Transaction-scoped: held for the whole
  --    of this function's transaction, which is exactly the cursor read and
  --    running-row insert it must serialize. A second concurrent start on
  --    any other connection fails the try and is refused cleanly.
  select pg_try_advisory_xact_lock(
           hashtext('ledgerlens_run'),
           hashtext(p_org_id::text)
         )
    into v_locked;

  if not v_locked then
    return query select false, 'advisory_lock_busy', null::uuid, null::text, v_reaped;
    return;
  end if;

  -- 3. Check under the lock. The partial unique index would reject a second
  --    running row anyway; this check turns that violation into a clean
  --    refusal with a reason instead of a 500. (A webhook run opened outside
  --    this lock can still be seen here - and vice versa; the index is the
  --    backstop for that interleaving, and the exception handler below turns
  --    it into the same clean refusal.)
  select exists (
    select 1 from public.pipeline_runs
     where org_id = p_org_id and status = 'running'
  ) into v_running;

  if v_running then
    return query select false, 'already_running', null::uuid, null::text, v_reaped;
    return;
  end if;

  -- 4. Resume cursor, read under the lock: the newest succeeded incremental
  --    run's cursor_to - US-01, exactly as the route used to read it. The
  --    not-null filter and kind filter matter (see the route's own comment):
  --    a cursorless webhook run must never masquerade as the resume point.
  select r.cursor_to into v_cursor
    from public.pipeline_runs r
   where r.org_id = p_org_id
     and r.source = p_source
     and r.kind = 'incremental'
     and r.status = 'succeeded'
     and r.cursor_to is not null
   order by r.finished_at desc nulls last
   limit 1;

  -- 5. Open the run.
  insert into public.pipeline_runs
    (org_id, source, kind, status, cursor_from, correlation_id)
  values
    (p_org_id, p_source, 'incremental', 'running', v_cursor, p_correlation_id)
  returning id into v_run_id;

  return query select true, null::text, v_run_id, v_cursor, v_reaped;

exception when unique_violation then
  -- The one-running-per-org index refused us at the insert (a webhook run
  -- slipped in after the check). Same clean refusal as step 3.
  return query select false, 'already_running', null::uuid, null::text, v_reaped;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. corpus_index_freshness - D-14's executable check (AC-05).
-- ---------------------------------------------------------------------------
-- Is the chunk index stale relative to the newest invoice? Compares the
-- newest invoice's transformed_at against the newest chunk written for this
-- org's invoices: an invoice newer than every chunk means the corpus has
-- text the index does not know about. 'empty' for an org with no invoices
-- (not a failure - a tenant with no data has nothing to index).
-- tests/index-freshness.spec.ts drives this red (new invoice, no chunk) and
-- green (reindex consumed, chunks updated).

create or replace function public.corpus_index_freshness(
  p_org_id uuid
)
returns table (status text, newest_invoice timestamptz, newest_indexed timestamptz)
language sql
set search_path = ''
as $$
  with newest as (
    select
      (select max(i.transformed_at)
         from public.invoices i
        where i.org_id = p_org_id) as invoice_at,
      (select max(c.updated_at)
         from public.chunks c
         join public.invoices i on i.id = c.invoice_id
        where i.org_id = p_org_id) as indexed_at
  )
  select
    case
      when invoice_at is null then 'empty'
      when indexed_at is null or indexed_at < invoice_at then 'stale'
      else 'fresh'
    end::text,
    invoice_at,
    indexed_at
  from newest;
$$;

-- ---------------------------------------------------------------------------
-- 7. The three jobs (AC-01: "select * from cron.job" shows them).
-- ---------------------------------------------------------------------------
-- Ingest and quality every 15 minutes (staggered so they do not collide on
-- the same minute), reindex hourly. All enqueue markers - see the header
-- comment for why the jobs do not call the routes directly. Idempotently
-- created: unschedule-then-schedule keeps the migration re-runnable against
-- a live database.

do $$
begin
  if exists (select 1 from cron.job where jobname = 'll_ingest') then
    perform cron.unschedule('ll_ingest');
  end if;
  perform cron.schedule_in_database(
    'll_ingest',
    '*/15 * * * *',
    $cron$select public.enqueue_scheduled_run('00000000-0000-4000-8000-000000000001', 'ingest');$cron$,
    'postgres'
  );
end;
$$;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'll_quality') then
    perform cron.unschedule('ll_quality');
  end if;
  perform cron.schedule_in_database(
    'll_quality',
    '2-59/15 * * * *',
    $cron$select public.enqueue_scheduled_run('00000000-0000-4000-8000-000000000001', 'quality');$cron$,
    'postgres'
  );
end;
$$;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'll_reindex') then
    perform cron.unschedule('ll_reindex');
  end if;
  perform cron.schedule_in_database(
    'll_reindex',
    '30 * * * *',
    $cron$select public.enqueue_scheduled_run('00000000-0000-4000-8000-000000000001', 'reindex');$cron$,
    'postgres'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Function privileges - the pipeline's own surface only, matching the
--    established pattern (revoke the Data API roles; service_role keeps
--    EXECUTE for the pipeline's client).
-- ---------------------------------------------------------------------------

revoke execute on function public.enqueue_scheduled_run(uuid, text)
  from public, anon, authenticated;
grant execute on function public.enqueue_scheduled_run(uuid, text)
  to service_role;

revoke execute on function public.try_start_polling_run(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.try_start_polling_run(uuid, text, text)
  to service_role;

revoke execute on function public.reap_abandoned_runs(uuid, text, interval)
  from public, anon, authenticated;
grant execute on function public.reap_abandoned_runs(uuid, text, interval)
  to service_role;

revoke execute on function public.corpus_index_freshness(uuid)
  from public, anon, authenticated;
grant execute on function public.corpus_index_freshness(uuid)
  to service_role;