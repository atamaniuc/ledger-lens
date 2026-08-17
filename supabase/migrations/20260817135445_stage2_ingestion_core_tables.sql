-- Stage 2 (Ingestion & Transform) core tables + RLS.
-- See docs/DATABASE_SCHEMA.md for the full documented schema and
-- .claude/DESIGN.md's "Ingestion & Transform" section for how these
-- tables are written to.

create extension if not exists pgcrypto;

create table orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null
);

create table memberships (
  user_id uuid not null,
  org_id  uuid not null references orgs(id) on delete cascade,
  role    text not null check (role in ('admin','member','viewer')),
  primary key (user_id, org_id)
);
create index memberships_org_id_idx on memberships (org_id);

create table pipeline_runs (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id) on delete cascade,
  source       text not null,
  kind         text not null check (kind in ('incremental','full','backfill')),
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  status       text not null default 'running'
               check (status in ('running','succeeded','failed')),
  cursor_from  text,
  cursor_to    text,
  rows_read    int not null default 0,
  rows_written int not null default 0,
  rows_quarantined int not null default 0,
  error        text
);
create index pipeline_runs_org_id_idx on pipeline_runs (org_id);
create index pipeline_runs_org_source_status_idx
  on pipeline_runs (org_id, source, status, finished_at desc);

create table raw_events (
  id            bigserial primary key,
  org_id        uuid not null references orgs(id) on delete cascade,
  source        text not null,
  external_id   text not null,
  event_version text not null default '1',
  payload       jsonb not null,
  payload_hash  text not null,
  run_id        uuid not null references pipeline_runs(id) on delete cascade,
  ingested_at   timestamptz not null default now(),
  unique (source, external_id, event_version)
);
create index raw_events_org_id_idx on raw_events (org_id);
create index raw_events_run_id_idx on raw_events (run_id);

create table invoices (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id) on delete cascade,
  external_id  text not null,
  customer     text not null,
  amount_cents bigint not null check (amount_cents >= 0),
  currency     char(3) not null,
  status       text not null check (status in ('draft','open','paid','void')),
  issued_at    date not null,
  paid_at      date,
  raw_event_id bigint not null references raw_events(id) on delete cascade,
  run_id       uuid not null references pipeline_runs(id) on delete cascade,
  transformed_at timestamptz not null default now(),
  pipeline_version text not null,
  unique (org_id, external_id)
);
create index invoices_org_id_idx on invoices (org_id);
create index invoices_raw_event_id_idx on invoices (raw_event_id);
create index invoices_run_id_idx on invoices (run_id);

create table quarantine (
  id          bigserial primary key,
  org_id      uuid not null references orgs(id) on delete cascade,
  raw_event_id bigint references raw_events(id) on delete cascade,
  run_id      uuid not null references pipeline_runs(id) on delete cascade,
  reason      text not null,
  details     jsonb,
  created_at  timestamptz not null default now()
);
create index quarantine_org_id_idx on quarantine (org_id);
create index quarantine_run_id_idx on quarantine (run_id);
create index quarantine_raw_event_id_idx on quarantine (raw_event_id);

-- RLS — every org-scoped table, enabled in the same migration that
-- creates it, per CLAUDE.md ("every table: RLS on" — not a suggestion)
-- and docs/DATABASE_SCHEMA.md's coverage mandate.

alter table memberships enable row level security;
alter table pipeline_runs enable row level security;
alter table raw_events enable row level security;
alter table invoices enable row level security;
alter table quarantine enable row level security;

create policy "read own memberships" on memberships
for select to authenticated
using (user_id = (select auth.uid()));

create policy "read own org pipeline_runs" on pipeline_runs
for select to authenticated
using (
  org_id in (select org_id from memberships where user_id = (select auth.uid()))
);

create policy "read own org raw_events" on raw_events
for select to authenticated
using (
  org_id in (select org_id from memberships where user_id = (select auth.uid()))
);

create policy "read own org invoices" on invoices
for select to authenticated
using (
  org_id in (select org_id from memberships where user_id = (select auth.uid()))
);

create policy "read own org quarantine" on quarantine
for select to authenticated
using (
  org_id in (select org_id from memberships where user_id = (select auth.uid()))
);

-- orgs itself: not org_id-scoped (it's the tenant root), but still not
-- world-readable — a user may only see orgs they're a member of.
alter table orgs enable row level security;
create policy "read own orgs" on orgs
for select to authenticated
using (
  id in (select org_id from memberships where user_id = (select auth.uid()))
);
