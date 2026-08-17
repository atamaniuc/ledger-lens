-- A serverless invocation killed mid-run (execution-time limit) never
-- reaches its own close-out code, so its pipeline_runs row stays
-- status='running' forever. The route's wall-clock budget makes that
-- unlikely rather than impossible, and nothing else in the system would
-- ever notice — the row just sits there, and the polling path's resume
-- query (which only accepts 'succeeded') silently discards its progress.
--
-- Called at the start of each run so abandonment is bounded by run
-- frequency, with no separate scheduler to deploy (ADR 0003: no job queue).
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

revoke execute on function public.reap_abandoned_runs(uuid, text, interval)
  from public, anon, authenticated;
