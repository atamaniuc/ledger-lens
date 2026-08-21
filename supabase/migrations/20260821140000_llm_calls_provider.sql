-- ADR 0010 (lane W3-I): the free-provider failover chain, recorded.
--
-- The copilot now picks a provider per step from an ordered chain, and the
-- provider that actually answered is what history must say. llm_calls already
-- records `model`; this migration adds `provider` (who answered) and
-- `preferred_provider` (the chain head at write time) so a fallback rate is
-- derivable from the table alone, by one query, without consulting deployment
-- config:
--
--   select round(
--     100.0 * count(*) filter (where provider is distinct from preferred_provider)
--     / nullif(count(*), 0), 2
--   ) as fallback_rate_pct
--   from llm_calls
--   where org_id = :org_id;
--
-- Both columns are stamped at write time (ADR 0009's price-table pattern): a
-- historical row keeps the provider that actually answered and the chain it
-- preferred on that day, rather than being silently rewritten by a later
-- reconfiguration. A turn a bound ended records provider = preferred_provider
-- (no call was made, so nothing fell back), which is what keeps the rate
-- above measuring only real degradation.
--
-- Explicitly out of scope (ADR 0010): rotating several keys of one provider
-- to defeat its own free-tier limit. The chain is one key per service.

alter table public.llm_calls
  add column provider text not null default '',
  add column preferred_provider text not null default '';

-- The writer grows the two new columns. Dropped and recreated rather than
-- create-or-replaced so the old 13-argument overload cannot linger and make
-- PostgREST's rpc("log_llm_call", ...) resolution ambiguous.
drop function if exists public.log_llm_call(
  uuid, text, int, text, text, int, int, numeric, int, text, jsonb, bigint[], text
);

create function log_llm_call(
  p_org_id                uuid,
  p_correlation_id        text,
  p_step_no               int,
  p_model                 text,
  p_prompt_version        text,
  p_input_tokens          int,
  p_output_tokens         int,
  p_cost_cents            numeric,
  p_latency_ms            int,
  p_tool_name             text,
  p_tool_args             jsonb,
  p_retrieved_chunk_ids   bigint[],
  p_outcome               text,
  p_provider              text default '',
  p_preferred_provider    text default ''
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
    tool_name, tool_args, retrieved_chunk_ids, outcome,
    provider, preferred_provider
  ) values (
    p_org_id, p_correlation_id, coalesce(p_step_no, 0), p_model, p_prompt_version,
    p_input_tokens, p_output_tokens, p_cost_cents, p_latency_ms,
    p_tool_name, p_tool_args, p_retrieved_chunk_ids, p_outcome,
    coalesce(p_provider, ''), coalesce(p_preferred_provider, '')
  )
  returning id into v_id;

  return v_id;
end;
$$;

-- Grants for the new signature: readable by its own org (unchanged), writable
-- by nobody, callable only by a signed-in user — same as before the change.
revoke all on function public.log_llm_call(
  uuid, text, int, text, text, int, int, numeric, int, text, jsonb, bigint[], text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.log_llm_call(
  uuid, text, int, text, text, int, int, numeric, int, text, jsonb, bigint[], text, text, text
) to authenticated;
