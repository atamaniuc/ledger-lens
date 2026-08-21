-- D-52: a daily token budget, on top of the request windows and the cost cap.
--
-- The cost cap (p_daily_cost_cap_cents) is blind to free tiers: a model that
-- costs nothing records cost_cents = 0, so a $10 cap never triggers while the
-- account burns the provider's entire free token quota. Counting tokens
-- instead of cents is the defence that works for every provider, free or paid.
--
-- The cap is per org, summed from llm_calls over the current UTC day. Like the
-- cost cap it is *checked* before a turn starts, not enforced mid-turn: a turn
-- that crosses the line completes, the next request is refused with reason
-- 'token_cap' and a 402 (a daily budget, not a request-frequency limit).
--
-- 0 disables the cap, matching the cost-cap convention.

create or replace function check_agent_budget(
  p_org_id                uuid,
  p_user_limit            int,
  p_org_limit             int,
  p_window_seconds        int,
  p_daily_cost_cap_cents  numeric,
  p_daily_token_cap       bigint
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
  v_tokens   bigint;
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
      'allowed', false, 'reason', 'rate_limit', 'scope', 'user',
      'retry_after_seconds', v_retry,
      'resets_at', to_char(v_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    );
  end if;

  if v_org_row is null then
    v_retry := greatest(1, ceil(extract(epoch from (v_end - clock_timestamp())))::int);
    return jsonb_build_object(
      'allowed', false, 'reason', 'rate_limit', 'scope', 'org',
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
        'allowed', false, 'reason', 'cost_cap',
        'retry_after_seconds', v_retry,
        'resets_at', to_char(
          (date_trunc('day', clock_timestamp()) + interval '1 day') AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS"Z"'
        )
      );
    end if;
  end if;

  if p_daily_token_cap is not null and p_daily_token_cap > 0 then
    select coalesce(sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0)), 0)
      into v_tokens
      from public.llm_calls
     where org_id = p_org_id
       and created_at >= date_trunc('day', clock_timestamp());

    if v_tokens >= p_daily_token_cap then
      v_retry := greatest(
        1,
        ceil(extract(epoch from (
          date_trunc('day', clock_timestamp()) + interval '1 day' - clock_timestamp()
        )))::int
      );
      return jsonb_build_object(
        'allowed', false, 'reason', 'token_cap',
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

revoke all on function public.check_agent_budget(uuid, int, int, int, numeric, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.check_agent_budget(uuid, int, int, int, numeric, bigint)
  to authenticated;

-- The 5-argument version is superseded; a stale overload would be a second
-- path with no token cap, which is exactly what this migration exists to close.
drop function if exists public.check_agent_budget(uuid, int, int, int, numeric);
