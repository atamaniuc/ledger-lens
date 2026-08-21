-- D-19: single-use nonce store backing the HMAC-signed Edge Function
-- entry points (provider-webhook, embed).
--
-- The previous scheme checked a static header secret, so anyone who
-- captured one request could replay it forever. The replacement signs the
-- raw body plus a timestamp and a nonce with HMAC-SHA256 (see
-- supabase/functions/_shared/signature.ts); this table is what makes the
-- nonce single-use, and it is what turns an at-least-once delivery into a
-- rejected replay instead of a second accepted run.
--
-- The table is fully closed: RLS is on with no policies, and nothing is
-- granted to anon/authenticated/service_role. The only path in is the
-- security-definer function below, which the Data API roles cannot call
-- (EXECUTE is granted to service_role alone). The function is security
-- definer precisely so the table needs no Data API grants at all — the
-- coverage spec forbids service_role DELETE outside the ADR allowance, and
-- the cleanup delete must live somewhere: inside the function, as the
-- table owner.
--
-- Expired rows are deleted on every write, so the table stays sized by
-- request volume instead of by time — no scheduler (ADR 0003: no job
-- queue).

create table public.signed_request_nonces (
  nonce      text primary key,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index signed_request_nonces_expires_at_idx
  on public.signed_request_nonces (expires_at);

alter table public.signed_request_nonces enable row level security;

-- Single-use claim: returns true only for a nonce never seen before, false
-- for a replay. p_expires_at is clamped to one hour so a misbehaving
-- caller cannot plant a nonce that outlives its usefulness and bloat the
-- table.
create or replace function public.consume_request_nonce(
  p_nonce      text,
  p_expires_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inserted boolean;
begin
  delete from public.signed_request_nonces where expires_at < now();

  p_expires_at := least(p_expires_at, now() + interval '1 hour');

  insert into public.signed_request_nonces (nonce, expires_at)
  values (p_nonce, p_expires_at)
  on conflict (nonce) do nothing
  returning true into v_inserted;

  return coalesce(v_inserted, false);
end;
$$;

-- Revoke first, then grant — same discipline as the explicit grants
-- migration: the end state must be identical whether the project predates
-- or postdates the "no auto-expose" default.
revoke all on table public.signed_request_nonces
  from anon, authenticated, service_role;

revoke execute on function public.consume_request_nonce(text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.consume_request_nonce(text, timestamptz)
  to service_role;
