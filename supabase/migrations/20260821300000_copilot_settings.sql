-- D-53: runtime copilot settings — guards flag, demo mode, and providers
-- configured at runtime instead of only from the environment.
--
-- Three knobs, one row (a singleton):
--
--   guards_enabled  false disables the budget gate (429/402) entirely. The
--                   point is a presentation or a stress test where the guard
--                   must not interrupt; the guard stays the default.
--   demo_mode       false by default. When true, the copilot NEVER shows a
--                   rate-limit error: if no provider can answer, it answers
--                   deterministically from this tenant's real data (the
--                   demo-answer path in the agent lane). Unconfigured, spent,
--                   rate-limited — in demo mode the answer still arrives.
--   providers       OpenAI-compatible providers added at runtime: name,
--                   base_url, model and the ENV VARIABLE NAME that holds the
--                   API key. The key itself never enters the database; the
--                   route resolves it from the environment at call time.
--                   A provider here joins the failover chain after the
--                   environment-configured ones.
--
-- Security: the table has NO Data API grants. Reads and writes go through
-- SECURITY DEFINER functions that check membership, so a client can never
-- read or edit settings it was not given permission to see.

create table public.copilot_settings (
  id            int primary key default 1 check (id = 1),
  guards_enabled boolean not null default true,
  demo_mode     boolean not null default false,
  providers     jsonb not null default '[]'::jsonb,
  updated_at    timestamptz not null default now()
);

alter table public.copilot_settings enable row level security;
-- No policies on purpose: nothing here is reachable through the Data API.

insert into public.copilot_settings (id) values (1);

-- Read: any signed-in member of the org the settings belong to (the table is
-- global; the caller's org is the one they belong to, enforced by passing it).
create or replace function get_copilot_settings(p_org_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
begin
  if v_user is null then
    raise exception 'get_copilot_settings requires an authenticated caller'
      using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.memberships m
     where m.user_id = v_user and m.org_id = p_org_id
  ) then
    raise exception 'caller is not a member of org %', p_org_id
      using errcode = '42501';
  end if;
  return (
    select jsonb_build_object(
      'guards_enabled', s.guards_enabled,
      'demo_mode', s.demo_mode,
      'providers', s.providers,
      'updated_at', s.updated_at
    )
    from public.copilot_settings s
    where s.id = 1
  );
end;
$$;

-- Write: admin/member of the org only. The route that calls this already
-- resolved the org from the caller's membership; this double-checks the role.
create or replace function update_copilot_settings(
  p_org_id       uuid,
  p_guards       boolean,
  p_demo_mode    boolean,
  p_providers    jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_role text;
begin
  if v_user is null then
    raise exception 'update_copilot_settings requires an authenticated caller'
      using errcode = '42501';
  end if;
  select role into v_role
    from public.memberships
   where user_id = v_user and org_id = p_org_id;
  if v_role is null then
    raise exception 'caller is not a member of org %', p_org_id
      using errcode = '42501';
  end if;
  if v_role <> 'admin' then
    raise exception 'only an admin may change copilot settings'
      using errcode = '42501';
  end if;

  update public.copilot_settings
     set guards_enabled = p_guards,
         demo_mode      = p_demo_mode,
         providers      = p_providers,
         updated_at     = now()
   where id = 1;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.get_copilot_settings(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_copilot_settings(uuid) to authenticated;
revoke all on function public.update_copilot_settings(uuid, boolean, boolean, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.update_copilot_settings(uuid, boolean, boolean, jsonb) to authenticated;
