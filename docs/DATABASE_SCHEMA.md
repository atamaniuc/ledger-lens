# LedgerLens — Database Schema

Full Postgres schema for LedgerLens, self-contained in this repository (not
dependent on personal, untracked notes). Target: Postgres via Supabase, with
`pgvector` for embeddings. See [`docs/PROJECT_OVERVIEW.md`](PROJECT_OVERVIEW.md)
for the entity-relationship diagram and how these tables fit into the
pipeline; see [`.claude/PRD.md`](../.claude/PRD.md) for the requirements each
table serves.

Apply as a Supabase migration (`supabase migration new init_schema`, paste
below, `supabase db push`) once the project is scaffolded — see
[`docs/DEPLOYMENT.md`](DEPLOYMENT.md).

Before changing anything here: load the `supabase:supabase-postgres-best-practices`
skill first, per `CLAUDE.md`'s Domain-Specific Rules — applies even to a
one-column change.

---

## Extensions

```sql
create extension if not exists vector;
create extension if not exists pgcrypto;
```

---

## Tenants and users

```sql
create table orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null
);

create table memberships (
  user_id uuid not null,
  org_id  uuid not null references orgs(id),
  role    text not null check (role in ('admin','member','viewer')),
  primary key (user_id, org_id)
);
```

---

## Pipeline runs

```sql
create table pipeline_runs (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id),
  source       text not null,
  kind         text not null check (kind in ('incremental','full','backfill')),
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  status       text not null default 'running'
               check (status in ('running','succeeded','failed')),
  cursor_from  text,
  cursor_to    text,
  rows_read    int default 0,
  rows_written int default 0,
  rows_quarantined int default 0,
  error        text
);
```

---

## Raw layer — nothing is discarded

```sql
create table raw_events (
  id            bigserial primary key,
  org_id        uuid not null references orgs(id),
  source        text not null,
  external_id   text not null,
  event_version text not null default '1',
  payload       jsonb not null,
  -- hash is computed application-side on insert: a generated column with
  -- digest() is finicky about the IMMUTABLE requirement — not worth the time
  payload_hash  text not null,
  run_id        uuid not null references pipeline_runs(id),
  ingested_at   timestamptz not null default now(),
  -- THIS is the idempotency guarantee
  unique (source, external_id, event_version)
);
```

---

## Staging / marts — typed facts

```sql
create table invoices (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id),
  external_id  text not null,
  customer     text not null,
  amount_cents bigint not null check (amount_cents >= 0),
  currency     char(3) not null,
  status       text not null check (status in ('draft','open','paid','void')),
  issued_at    date not null,
  paid_at      date,
  -- lineage
  raw_event_id bigint not null references raw_events(id),
  run_id       uuid not null references pipeline_runs(id),
  transformed_at timestamptz not null default now(),
  pipeline_version text not null,
  unique (org_id, external_id)
);
```

---

## Quarantine — bad records are never lost or block the load

```sql
create table quarantine (
  id          bigserial primary key,
  org_id      uuid not null references orgs(id),
  raw_event_id bigint references raw_events(id),
  run_id      uuid not null references pipeline_runs(id),
  reason      text not null,
  details     jsonb,
  created_at  timestamptz not null default now()
);
```

---

## Data quality

```sql
create table data_quality_results (
  id         bigserial primary key,
  org_id     uuid not null references orgs(id),
  run_id     uuid references pipeline_runs(id),
  check_name text not null,       -- freshness | volume | uniqueness | reconciliation
  status     text not null check (status in ('pass','warn','fail')),
  observed   numeric,
  expected   numeric,
  delta      numeric,
  details    jsonb,
  created_at timestamptz not null default now()
);
```

---

## Documents and RAG

```sql
create table documents (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references orgs(id),
  title      text not null,
  source_uri text,
  created_at timestamptz not null default now()
);

create table chunks (
  id           bigserial primary key,
  org_id       uuid not null references orgs(id),
  document_id  uuid not null references documents(id) on delete cascade,
  chunk_index  int not null,
  content      text not null,
  embedding    vector(1536),
  embed_model  text not null,
  tsv tsvector generated always as (to_tsvector('english', content)) stored,
  indexed_at   timestamptz not null default now()
);
create index on chunks using hnsw (embedding vector_cosine_ops);
create index on chunks using gin (tsv);
create index on chunks (org_id);
```

---

## Audit — append-only

```sql
create table audit_log (
  id          bigserial primary key,
  org_id      uuid not null references orgs(id),
  actor_type  text not null check (actor_type in ('user','service','agent')),
  actor_id    text not null,
  on_behalf_of uuid,               -- for an agent: acting on behalf of whom
  action      text not null,
  entity      text,
  entity_id   text,
  before      jsonb,
  after       jsonb,
  request_id  text,
  created_at  timestamptz not null default now()
);
revoke update, delete on audit_log from public;
```

---

## LLM call traces

```sql
create table llm_calls (
  id             bigserial primary key,
  org_id         uuid not null references orgs(id),
  request_id     text not null,
  step           int not null default 0,
  model          text not null,
  prompt_version text not null,
  input_tokens   int, output_tokens int,
  cost_usd       numeric(10,6),
  latency_ms     int,
  retrieved_chunk_ids bigint[],
  tool_name      text,
  tool_args      jsonb,
  output_valid   boolean,
  created_at     timestamptz not null default now()
);
```

---

## Job queue

```sql
create table jobs (
  id         bigserial primary key,
  org_id     uuid not null references orgs(id),
  kind       text not null,
  payload    jsonb not null,
  status     text not null default 'pending',
  attempts   int not null default 0,
  run_after  timestamptz not null default now(),
  locked_at  timestamptz,
  last_error text
);
create index on jobs (status, run_after);
```

Consumed with `SELECT ... FOR UPDATE SKIP LOCKED` for concurrent-safe
polling. See the "Background jobs, event-driven" row in `.claude/PRD.md`'s
overview for why this is paired with a webhook path rather than relied on
alone.

---

## Row-Level Security

Minimum viable RLS — enable on at least these three, extend to every
table that holds org-scoped data before shipping (per `CLAUDE.md`: *every
table, RLS on*):

```sql
alter table invoices enable row level security;
alter table chunks   enable row level security;
alter table audit_log enable row level security;

create policy "read own org invoices" on invoices
for select to authenticated
using (
  org_id in (
    select org_id from memberships
    where user_id = (select auth.uid())
  )
);

create policy "read own org chunks" on chunks
for select to authenticated
using (
  org_id in (
    select org_id from memberships
    where user_id = (select auth.uid())
  )
);
```

`(select auth.uid())` (wrapped in a subquery, not called bare) is the
Supabase-documented RLS performance optimization — the planner can cache it
once per statement instead of re-evaluating per row.

**Verification (Definition of Done item 4):** query as a user who is *not*
a member of the target `org_id` and confirm the result set is empty — not
an error, not another org's masked data, empty.

---

## Reconciliation source of truth

The mock provider's `/api/mock-provider/summary` endpoint is the
independent total that `data_quality_results`' `reconciliation` check
compares `sum(invoices.amount_cents)` against, per org. It is deliberately
computed from a source *other than* `raw_events`/`invoices` — reconciling
against your own derived data proves nothing, since duplicated rows are
perfectly internally consistent with themselves.
