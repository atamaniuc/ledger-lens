-- Local development seed. Runs on `supabase db reset` (config.toml
-- [db.seed]) against the local stack only — never against the hosted
-- project, which has no seed step.
--
-- Purpose: give every local test a stable, copy-pasteable tenant set.
-- The UUIDs are fixed on purpose so docs/LOCAL_DEV.md's curl commands and
-- scripts/smoke.sh can hardcode them instead of scraping them out of a
-- previous response.
--
-- Two orgs, not one: cross-tenant isolation is a Definition of Done item
-- (RLS returns empty for a non-member, and the tenant-scoped idempotency
-- key must let both orgs ingest the same external_id). Neither is testable
-- with a single tenant.

insert into public.orgs (id, name) values
  ('00000000-0000-4000-8000-000000000001', 'Acme Corp'),
  ('00000000-0000-4000-8000-000000000002', 'Globex Inc')
on conflict (id) do nothing;

-- Auth users. Local-only credentials, deliberately trivial: these exist so
-- RLS can be exercised as a real authenticated user (`select auth.uid()`
-- in every policy) rather than only as the RLS-bypassing service role.
--
--   alice@acme.test  / password123  -> member of Acme
--   bob@globex.test  / password123  -> member of Globex
--
-- bob is the negative control: querying Acme's rows as bob must return
-- zero rows, not an error and not masked data.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data
) values
  ('00000000-0000-0000-0000-000000000000',
   '00000000-0000-4000-9000-000000000001', 'authenticated', 'authenticated',
   'alice@acme.test', crypt('password123', gen_salt('bf')),
   now(), now(), now(),
   '{"provider":"email","providers":["email"]}', '{}'),
  ('00000000-0000-0000-0000-000000000000',
   '00000000-0000-4000-9000-000000000002', 'authenticated', 'authenticated',
   'bob@globex.test', crypt('password123', gen_salt('bf')),
   now(), now(), now(),
   '{"provider":"email","providers":["email"]}', '{}')
on conflict (id) do nothing;

-- GoTrue requires a matching identity row before it will issue a token for
-- an email/password user; without this, sign-in returns "Invalid login
-- credentials" even though the users row exists.
insert into auth.identities (
  id, user_id, provider_id, provider, identity_data,
  last_sign_in_at, created_at, updated_at
) values
  (gen_random_uuid(), '00000000-0000-4000-9000-000000000001',
   '00000000-0000-4000-9000-000000000001', 'email',
   '{"sub":"00000000-0000-4000-9000-000000000001","email":"alice@acme.test","email_verified":true,"phone_verified":false}',
   now(), now(), now()),
  (gen_random_uuid(), '00000000-0000-4000-9000-000000000002',
   '00000000-0000-4000-9000-000000000002', 'email',
   '{"sub":"00000000-0000-4000-9000-000000000002","email":"bob@globex.test","email_verified":true,"phone_verified":false}',
   now(), now(), now())
on conflict do nothing;

insert into public.memberships (user_id, org_id, role) values
  ('00000000-0000-4000-9000-000000000001',
   '00000000-0000-4000-8000-000000000001', 'admin'),
  ('00000000-0000-4000-9000-000000000002',
   '00000000-0000-4000-8000-000000000002', 'admin')
on conflict (user_id, org_id) do nothing;
