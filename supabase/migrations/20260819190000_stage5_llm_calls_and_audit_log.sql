-- Stage 5 observability: what the agent spent, and what it did.
--
-- ADR 0009. Two tables and two writers, and the writers are the point: these
-- are `SECURITY DEFINER` functions that stamp `auth.uid()` themselves, and
-- neither table grants INSERT to `authenticated`. A policy permissive enough
-- for the agent to insert its own audit rows is a policy permissive enough
-- for any user with the anon key and curl to fabricate them — an audit log
-- its own subject can write to is not an audit log.
--
-- Every row in one request's chain carries the same `correlation_id`, per
-- CLAUDE.md's project-wide logging contract.

create table llm_calls (
  id             bigint generated always as identity primary key,
  org_id         uuid not null references orgs(id) on delete cascade,
  correlation_id text not null,
  -- 0 is the first model call of a turn; each tool round trip increments it.
  step_no        int not null default 0 check (step_no >= 0),
  model          text not null,
  prompt_version text not null,
  input_tokens   int check (input_tokens >= 0),
  output_tokens  int check (output_tokens >= 0),
  -- Computed at write time from the price table in lib/agent/pricing.ts, so a
  -- historical row keeps the price actually paid rather than being silently
  -- rewritten by a later price change (ADR 0009).
  cost_cents     numeric(12,4) check (cost_cents >= 0),
  latency_ms     int check (latency_ms >= 0),
  tool_name      text,
  tool_args      jsonb,
  retrieved_chunk_ids bigint[],
  -- How the step ended. A turn that hit a bound has to say which one: a
  -- truncated answer presented as a complete one is the failure this column
  -- exists to make visible.
  outcome        text not null
                 check (outcome in ('ok','abstained','step_cap','timeout','token_ceiling','error')),
  created_at     timestamptz not null default now()
);
create index llm_calls_org_id_idx on llm_calls (org_id);
create index llm_calls_correlation_id_idx on llm_calls (correlation_id, step_no);

create table audit_log (
  id             bigint generated always as identity primary key,
  org_id         uuid not null references orgs(id) on delete cascade,
  correlation_id text not null,
  actor_type     text not null check (actor_type in ('user','service','agent')),
  actor_id       text not null,
  -- For an agent: the user it acted for. Never null for actor_type 'agent'.
  on_behalf_of   uuid,
  action         text not null,
  entity         text,
  entity_id      text,
  details        jsonb,
  created_at     timestamptz not null default now(),
  constraint audit_log_agent_names_its_principal
    check (actor_type <> 'agent' or on_behalf_of is not null)
);
create index audit_log_org_id_idx on audit_log (org_id);
create index audit_log_correlation_id_idx on audit_log (correlation_id, created_at);

alter table llm_calls enable row level security;
alter table audit_log enable row level security;

-- Read-own-org only. There is deliberately no INSERT, UPDATE or DELETE policy
-- on either table: RLS denies what no policy allows, and the definer
-- functions below are the only way in.
create policy "read own org llm_calls" on llm_calls
for select to authenticated
using (
  org_id in (select org_id from memberships where user_id = (select auth.uid()))
);

create policy "read own org audit_log" on audit_log
for select to authenticated
using (
  org_id in (select org_id from memberships where user_id = (select auth.uid()))
);

-- The writers. SECURITY DEFINER, empty search_path, and each one establishes
-- the caller's identity and membership itself rather than trusting an
-- argument — the same reason ADR 0008 refused a SECURITY DEFINER search
-- function taking an org_id: a tenant selector supplied by the caller is not
-- an authorization check.
create function log_llm_call(
  p_org_id         uuid,
  p_correlation_id text,
  p_step_no        int,
  p_model          text,
  p_prompt_version text,
  p_input_tokens   int,
  p_output_tokens  int,
  p_cost_cents     numeric,
  p_latency_ms     int,
  p_tool_name      text,
  p_tool_args      jsonb,
  p_retrieved_chunk_ids bigint[],
  p_outcome        text
) returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_id   bigint;
begin
  if v_user is null then
    raise exception 'log_llm_call requires an authenticated caller'
      using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.memberships m
     where m.user_id = v_user and m.org_id = p_org_id
  ) then
    raise exception 'caller is not a member of org %', p_org_id
      using errcode = '42501';
  end if;

  insert into public.llm_calls (
    org_id, correlation_id, step_no, model, prompt_version,
    input_tokens, output_tokens, cost_cents, latency_ms,
    tool_name, tool_args, retrieved_chunk_ids, outcome
  ) values (
    p_org_id, p_correlation_id, coalesce(p_step_no, 0), p_model, p_prompt_version,
    p_input_tokens, p_output_tokens, p_cost_cents, p_latency_ms,
    p_tool_name, p_tool_args, p_retrieved_chunk_ids, p_outcome
  )
  returning id into v_id;

  return v_id;
end;
$$;

create function log_agent_action(
  p_org_id         uuid,
  p_correlation_id text,
  p_action         text,
  p_entity         text,
  p_entity_id      text,
  p_details        jsonb
) returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_id   bigint;
begin
  if v_user is null then
    raise exception 'log_agent_action requires an authenticated caller'
      using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.memberships m
     where m.user_id = v_user and m.org_id = p_org_id
  ) then
    raise exception 'caller is not a member of org %', p_org_id
      using errcode = '42501';
  end if;

  -- actor_type and on_behalf_of are stamped here, not passed in. A caller
  -- that could choose them could write an audit trail naming someone else.
  insert into public.audit_log (
    org_id, correlation_id, actor_type, actor_id, on_behalf_of,
    action, entity, entity_id, details
  ) values (
    p_org_id, p_correlation_id, 'agent', 'ledgerlens-agent', v_user,
    p_action, p_entity, p_entity_id, p_details
  )
  returning id into v_id;

  return v_id;
end;
$$;

-- Grants. Both tables are readable by their own org and writable by nobody;
-- both functions are callable only by a signed-in user, which is the only
-- context in which they have an identity to stamp.
revoke all on table public.llm_calls, public.audit_log
  from anon, authenticated, service_role;

grant select on table public.llm_calls, public.audit_log to authenticated;

-- service_role reads them for the evals harness (Stage 6) and writes neither.
grant select on table public.llm_calls, public.audit_log to service_role;

revoke all on function public.log_llm_call(
  uuid, text, int, text, text, int, int, numeric, int, text, jsonb, bigint[], text
) from public, anon, authenticated, service_role;
grant execute on function public.log_llm_call(
  uuid, text, int, text, text, int, int, numeric, int, text, jsonb, bigint[], text
) to authenticated;

revoke all on function public.log_agent_action(uuid, text, text, text, text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.log_agent_action(uuid, text, text, text, text, jsonb)
  to authenticated;
