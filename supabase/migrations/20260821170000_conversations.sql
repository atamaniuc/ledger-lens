-- Spec 0013 (lane W3): conversation memory — bounded follow-up history.
-- Closes D-44's memory half.
--
-- The copilot was single-turn: "and the second one?" started from nothing.
-- This migration adds the two tables that make a follow-up see the prior
-- question and answer, scoped and protected exactly like every other table in
-- the schema:
--
--   * conversations and conversation_turns are org-scoped, RLS-enabled on
--     creation, and readable by their own org under the same membership
--     policy every other table uses (the D-30 coverage test walks the
--     catalog, so a table that arrives without RLS fails the suite).
--   * Writes go through SECURITY DEFINER functions that stamp auth.uid()
--     and verify membership themselves — the same shape as the audit writers
--     (migration 20260819190000). authenticated holds SELECT only, so an end
--     user can read their own org's history and cannot fabricate anyone's.
--   * The client is untrusted input (ADR 0009): the route accepts a
--     conversation_id but history is re-fetched from these rows, never
--     replayed from the request, and a conversation that does not belong to
--     the caller's org returns nothing.
--
-- This migration also widens llm_calls.outcome with 'cancelled' (spec 0013's
-- US-04): a client that aborts a streaming turn lands in the audit as
-- cancelled, and a cancelled turn must never be recorded as an answer.

-- ---------------------------------------------------------------------------
-- 1. conversations and conversation_turns
-- ---------------------------------------------------------------------------

create table public.conversations (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references orgs(id) on delete cascade,
  -- The correlation_id of the turn that opened the conversation; every turn
  -- row below carries its own correlation_id too.
  correlation_id text not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table public.conversation_turns (
  id              bigint generated always as identity primary key,
  conversation_id uuid not null references conversations(id) on delete cascade,
  org_id          uuid not null references orgs(id) on delete cascade,
  correlation_id  text not null,
  question        text not null,
  answer          text not null,
  -- Memory stores only turns that produced a deliverable answer. A turn a
  -- bound ended (step cap, timeout, ceiling, cancelled) is audited in
  -- llm_calls, not remembered — a follow-up must not be built on an answer
  -- that was never delivered.
  outcome         text not null check (outcome in ('ok','abstained')),
  created_at      timestamptz not null default now()
);

create index conversation_turns_org_idx
  on public.conversation_turns (org_id, conversation_id);
create index conversation_turns_correlation_idx
  on public.conversation_turns (correlation_id);

-- RLS on the same migration that creates the tables (the D-30 coverage test
-- asserts it against the catalog). Read-own-org only; nobody but the definer
-- functions below writes.
alter table public.conversations enable row level security;
alter table public.conversation_turns enable row level security;

create policy "read own org conversations" on public.conversations
for select to authenticated
using (
  org_id in (select org_id from memberships where user_id = (select auth.uid()))
);

create policy "read own org conversation_turns" on public.conversation_turns
for select to authenticated
using (
  org_id in (select org_id from memberships where user_id = (select auth.uid()))
);

-- Explicit grants, per 20260818094500: revoke the Data API roles to nothing,
-- then grant back only the read verb. Writes are the functions' alone.
revoke all on table public.conversations, public.conversation_turns
  from anon, authenticated, service_role;
revoke all on sequence public.conversation_turns_id_seq
  from anon, authenticated, service_role;

grant select on table public.conversations, public.conversation_turns
  to authenticated;
grant select on table public.conversations, public.conversation_turns
  to service_role;

-- ---------------------------------------------------------------------------
-- 2. The writers — SECURITY DEFINER, membership verified, org never guessed
-- ---------------------------------------------------------------------------

-- Appends one delivered turn to a conversation, creating the conversation
-- row on first use. The conversation id is caller-supplied (the panel mints
-- it and sends it back on follow-ups), so the function checks it against the
-- caller's org rather than trusting it: an id that names another tenant's
-- conversation is refused, and an id that does not exist yet is created in
-- the caller's org.
create function public.save_conversation_turn(
  p_org_id          uuid,
  p_conversation_id uuid,
  p_correlation_id  text,
  p_question        text,
  p_answer          text,
  p_outcome         text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
begin
  if v_user is null then
    raise exception 'save_conversation_turn requires an authenticated caller'
      using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.memberships m
     where m.user_id = v_user and m.org_id = p_org_id
  ) then
    raise exception 'caller is not a member of org %', p_org_id
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.conversations c where c.id = p_conversation_id
  ) then
    insert into public.conversations (id, org_id, correlation_id)
    values (p_conversation_id, p_org_id, p_correlation_id);
  else
    if not exists (
      select 1 from public.conversations c
       where c.id = p_conversation_id and c.org_id = p_org_id
    ) then
      raise exception 'conversation % does not belong to org %', p_conversation_id, p_org_id
        using errcode = '42501';
    end if;
  end if;

  insert into public.conversation_turns (
    conversation_id, org_id, correlation_id, question, answer, outcome
  ) values (
    p_conversation_id, p_org_id, p_correlation_id, p_question, p_answer, p_outcome
  );

  update public.conversations
     set updated_at = now()
   where id = p_conversation_id;

  return p_conversation_id;
end;
$$;

-- The bounded history a follow-up sees: the caller's own turns, oldest first,
-- so the loop can keep the newest under its token budget and drop the oldest.
-- A conversation that does not exist or belongs to another org returns no
-- rows — an id the client names is never an authorization check.
create function public.get_conversation_history(
  p_org_id          uuid,
  p_conversation_id uuid
) returns table (question text, answer text, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
begin
  if v_user is null then
    raise exception 'get_conversation_history requires an authenticated caller'
      using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.memberships m
     where m.user_id = v_user and m.org_id = p_org_id
  ) then
    raise exception 'caller is not a member of org %', p_org_id
      using errcode = '42501';
  end if;

  return query
    select t.question, t.answer, t.created_at
      from public.conversation_turns t
      join public.conversations c on c.id = t.conversation_id
     where t.conversation_id = p_conversation_id
       and c.org_id = p_org_id
     order by t.id asc;
end;
$$;

revoke all on function public.save_conversation_turn(
  uuid, uuid, text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.save_conversation_turn(
  uuid, uuid, text, text, text, text
) to authenticated;

revoke all on function public.get_conversation_history(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_conversation_history(uuid, uuid)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 3. llm_calls.outcome gains 'cancelled' (spec 0013, US-04)
-- ---------------------------------------------------------------------------
-- The check constraint created by migration 20260819190000 is widened, not
-- replaced in spirit: every existing value stays valid, and 'cancelled' is
-- the one new way a turn can end. Dropped and re-added under the same name
-- so the constraint set (and the fallback-rate query in 20260821140000) is
-- untouched.

alter table public.llm_calls drop constraint llm_calls_outcome_check;
alter table public.llm_calls
  add constraint llm_calls_outcome_check
  check (outcome in ('ok','abstained','step_cap','timeout','token_ceiling','error','cancelled'));