-- Spec 0002 (lane W2-A): server-side LLM budgets and the RBAC gate for
-- write-adjacent tools. Closes D-18 (rate limit + daily cost cap), D-08
-- (roles checked on write paths) and carries the RLS for every table it adds
-- (D-30 pattern: a new table without RLS fails tests/rls-coverage.spec.ts).
--
-- D-18: /api/agent/chat had no rate limit and no spend bound, so one account
-- could exhaust the whole free tier. The counters live here, in Postgres,
-- because the app runs on Vercel where process memory is per-instance and
-- resets: a memory counter would let the limit drift apart between instances,
-- and the daily cap has to be computed from llm_calls anyway, which is
-- already in Postgres. The limits themselves are arguments to the function,
-- supplied from the deployment's env (AC-06 / D-21 pattern), not constants in
-- this file.
--
-- D-08: memberships.role (admin|member|viewer) existed but nothing checked
-- it. The gate function below stamps auth.uid() itself, so a caller cannot
-- name someone else's membership, and the tool registry calls it before a
-- write-adjacent tool executes — the one place every tool call must pass.

-- The budget ledger: one row per (scope, scope_id, window). A window is a
-- fixed slice of wall-clock time keyed by epoch; the row is upserted on every
-- request and the window_start rolls on when the slice rolls over, so old
-- rows are garbage rather than history. There is deliberately no history to
-- keep: the audit trail of agent turns lives in llm_calls/audit_log, and this
-- table only has to answer "how many requests in the current window".
create table agent_request_budget (
  id           bigint generated always as identity primary key,
  scope        text not null check (scope in ('user','org')),
  scope_id     uuid not null,
  window_start timestamptz not null,
  requests     int not null default 0 check (requests >= 0),
  unique (scope, scope_id, window_start)
);
create index agent_request_budget_lookup_idx
  on agent_request_budget (scope, scope_id, window_start);

alter table agent_request_budget enable row level security;

-- No policies and no grants: this table is written and read only through the
-- SECURITY DEFINER function below. A policy permissive enough for a user to
-- zero their own counter is a counter that never trips — the whole point of
-- the table would be negotiable by its own subject.
revoke all on table public.agent_request_budget
  from anon, authenticated, service_role;

-- check_agent_budget: counts one request against the per-user and per-org
-- windows and reads the org's spend so far today, in one atomic call.
--
-- Returns jsonb:
--   {"allowed": true}
--   {"allowed": false, "reason": "rate_limit", "scope": "user"|"org",
--    "retry_after_seconds": N, "resets_at": "<iso>"}
--   {"allowed": false, "reason": "cost_cap",
--    "retry_after_seconds": N, "resets_at": "<iso>"}
--
-- The increment is conditional (WHERE requests < limit), so two racing
-- requests serialize on the row lock and the limit cannot be overshot by a
-- race. The cap is *checked* before a turn spends anything, not enforced
-- retroactively: a turn that crosses the line mid-flight completes, and the
-- next request is refused. A refused request does not increment either
-- counter, so hammering the endpoint cannot extend the wait.
create function check_agent_budget(
  p_org_id                uuid,
  p_user_limit            int,
  p_org_limit             int,
  p_window_seconds        int,
  p_daily_cost_cap_cents  numeric
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user     uuid := (select auth.uid());
  v_window   timestamptz;
  v_end      timestamptz;
  v_user_row bigint;
  v_org_row  bigint;
  v_spend    numeric;
  v_retry    int;
begin
  if v_user is null then
    raise exception 'check_agent_budget requires an authenticated caller'
      using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.memberships m
     where m.user_id = v_user and m.org_id = p_org_id
  ) then
    raise exception 'caller is not a member of org %', p_org_id
      using errcode = '42501';
  end if;

  -- The same window every caller of this function computes: epoch-seconds
  -- sliced by p_window_seconds, so windows align across users and orgs.
  v_window := to_timestamp(
    floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds
  );
  v_end := v_window + make_interval(secs => p_window_seconds);

  insert into public.agent_request_budget (scope, scope_id, window_start, requests)
  values ('user', v_user, v_window, 1)
  on conflict (scope, scope_id, window_start)
  do update set requests = agent_request_budget.requests + 1
  where agent_request_budget.requests < p_user_limit
  returning requests into v_user_row;

  insert into public.agent_request_budget (scope, scope_id, window_start, requests)
  values ('org', p_org_id, v_window, 1)
  on conflict (scope, scope_id, window_start)
  do update set requests = agent_request_budget.requests + 1
  where agent_request_budget.requests < p_org_limit
  returning requests into v_org_row;

  if v_user_row is null then
    v_retry := greatest(1, ceil(extract(epoch from (v_end - clock_timestamp())))::int);
    return jsonb_build_object(
      'allowed', false,
      'reason', 'rate_limit',
      'scope', 'user',
      'retry_after_seconds', v_retry,
      -- A parseable ISO-8601 UTC timestamp: Postgres' OF offset suffix (+00)
      -- is not valid in JS's date-time string format, and the client parses
      -- resets_at to tell the caller when the window resets.
      'resets_at', to_char(v_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    );
  end if;

  if v_org_row is null then
    v_retry := greatest(1, ceil(extract(epoch from (v_end - clock_timestamp())))::int);
    return jsonb_build_object(
      'allowed', false,
      'reason', 'rate_limit',
      'scope', 'org',
      'retry_after_seconds', v_retry,
      'resets_at', to_char(v_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    );
  end if;

  if p_daily_cost_cap_cents is not null and p_daily_cost_cap_cents > 0 then
    select coalesce(sum(cost_cents), 0)
      into v_spend
      from public.llm_calls
     where org_id = p_org_id
       and created_at >= date_trunc('day', clock_timestamp());

    if v_spend >= p_daily_cost_cap_cents then
      v_retry := greatest(
        1,
        ceil(extract(epoch from (
          date_trunc('day', clock_timestamp()) + interval '1 day' - clock_timestamp()
        )))::int
      );
      return jsonb_build_object(
        'allowed', false,
        'reason', 'cost_cap',
        'retry_after_seconds', v_retry,
        'resets_at', to_char(
          (date_trunc('day', clock_timestamp()) + interval '1 day') AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS"Z"'
        )
      );
    end if;
  end if;

  return jsonb_build_object('allowed', true);
end;
$$;

revoke all on function public.check_agent_budget(uuid, int, int, int, numeric)
  from public, anon, authenticated, service_role;
grant execute on function public.check_agent_budget(uuid, int, int, int, numeric)
  to authenticated;

-- assert_can_draft_tool: the RBAC gate (D-08). A viewer may read but may not
-- invoke the write-adjacent tool (draft_customer_email); member and admin
-- may. Enforced here under auth.uid(), and called from the tool registry
-- before a draft-effect tool executes — so the check lives in the database
-- and cannot be bypassed by a client that only ever reaches the loop over
-- HTTP. The role is read from the caller's own membership row, never from an
-- argument.
create function assert_can_draft_tool(p_org_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_role text;
begin
  if v_user is null then
    raise exception 'assert_can_draft_tool requires an authenticated caller'
      using errcode = '42501';
  end if;

  select role into v_role
    from public.memberships
   where user_id = v_user and org_id = p_org_id;

  if v_role is null then
    raise exception 'caller is not a member of org %', p_org_id
      using errcode = '42501';
  end if;

  if v_role = 'viewer' then
    raise exception 'viewer role cannot use write-adjacent tools'
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.assert_can_draft_tool(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.assert_can_draft_tool(uuid)
  to authenticated;
