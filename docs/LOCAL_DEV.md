# Local Development

How to run LedgerLens on your machine, verify a stage by hand (browser +
curl), and point a SQL client such as IntelliJ IDEA at the database.

Everything here targets the **local** Supabase stack, not the hosted
project. The local stack is a full Postgres + Auth + Studio running in
Docker, seeded from `supabase/seed.sql`, and it is the right place to test
a stage: it can be reset to a known state in seconds, its credentials are
non-secret by design, and a mistake there costs nothing.

---

## Prerequisites

| Tool | Why | Check |
|---|---|---|
| [Docker Desktop](https://docs.docker.com/desktop/) | runs the local Supabase stack | `docker info` |
| [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started) | starts/resets the stack, applies migrations | `supabase --version` |
| [Bun](https://bun.sh) | package manager, dev server, test runner | `bun --version` |
| `psql` | ad-hoc queries; the test suite talks to Postgres directly | `psql --version` |
| [Deno](https://deno.land) *(optional)* | type-checks `supabase/functions/` — `make check` skips this gate loudly when absent | `deno --version` |

---

## One-time setup

```bash
bun install
supabase start          # first run pulls several GB of images
```

`supabase start` prints the local URLs and keys. Write them into
`.env.local` (gitignored — see the template in `.env.example`):

```bash
# .env.local
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_SERVICE_ROLE_KEY=<the "service_role key" supabase start printed>
INGESTION_TRIGGER_SECRET=local-dev-ingestion-secret
WEBHOOK_SHARED_SECRET=local-dev-webhook-secret
```

Reprint those values at any time with `supabase status`.

The local `service_role` key is a fixed, publicly documented development
key — it is not a secret and grants nothing outside your machine. The
hosted project's key is a real secret and must never appear in a file that
git tracks. `.env.local` is gitignored precisely so the same variable name
can hold either.

Then load the schema and the seed data:

```bash
supabase db reset       # drops, re-applies every migration, runs seed.sql
```

`db reset` is also the only automated check that the migrations apply
cleanly from an empty database, in order. It earns its keep: the first
time it ran it caught two ways the schema had quietly become
non-reproducible, both invisible against the hosted project — a REVOKE on
a function that only exists there, and a set of table grants that the
hosted project's legacy "auto-expose new tables" default had been
supplying for free. Run it after every migration, not only when something
looks wrong.

### What the seed gives you

Two tenants, because cross-tenant isolation is a Definition of Done item
and cannot be tested with one:

| Org | `org_id` | User | Password |
|---|---|---|---|
| Acme Corp | `00000000-0000-4000-8000-000000000001` | `alice@acme.test` | `password123` |
| Globex Inc | `00000000-0000-4000-8000-000000000002` | `bob@globex.test` | `password123` |

The UUIDs are fixed so the curl commands below and the Playwright specs
can name them.

---

## Daily loop

```bash
supabase start          # if not already running
bun run dev             # http://localhost:3000
```

```bash
make check              # typecheck + lint + unit tests (+ deno check)
make e2e                # Playwright: the running app against a running database
make verify             # both, in that order
supabase stop           # when done; add --no-backup to discard local data
```

`make check` and `make e2e` answer different questions. `make check`
proves the pure logic is right, with no server and no database. `make e2e`
proves the running app talks to a running Postgres correctly — HTTP status
codes, RLS under a real JWT, idempotency across two actual runs. A stage
is not verified until both are green, which is what `make verify` runs.

---

## Local URLs

| What | URL |
|---|---|
| App | http://localhost:3000 |
| Supabase Studio (table editor, SQL editor, auth users) | http://127.0.0.1:54323 |
| Supabase API gateway | http://127.0.0.1:54321 |
| Postgres | `127.0.0.1:54322` |
| Mailpit (catches all local auth emails) | http://127.0.0.1:54324 |

---

## Verifying by hand

### In the browser

Open these directly — both are `GET` routes that render as JSON:

- <http://localhost:3000/api/mock-provider/summary> — the provider's own
  independent total. Always computed from the deduplicated dataset, which
  is what makes it usable as a reconciliation source of truth.
- <http://localhost:3000/api/mock-provider/invoices> — one page of
  invoices, with all seven chaos flags on.
- <http://localhost:3000/api/mock-provider/invoices?duplicates=false&schemaDrift=false&nullFields=false&rateLimit=false&serverError=false&expiredToken=false&futureDates=false>
  — the same page with the upstream behaving itself. Diff the two to see
  exactly what the chaos flags inject.

Reload the first URL ten times and one load returns HTTP 429: the
rate-limit flag fires on every tenth request. Chrome's DevTools Network
tab shows the status and the `Retry-After` header.

`POST /api/ingestion/run` cannot be triggered from the address bar (it
needs a POST and a header) — use curl.

### With curl

Stage 1 — the mock provider:

```bash
# One page, chaos as configured
curl -s localhost:3000/api/mock-provider/invoices | jq

# Walk the cursor
curl -s 'localhost:3000/api/mock-provider/invoices?cursor=20' | jq '.next_cursor'

# Isolate one failure mode: only rate limiting on, everything else off
for i in $(seq 1 10); do
  curl -s -o /dev/null -w '%{http_code}\n' \
    'localhost:3000/api/mock-provider/invoices?rateLimit=true&duplicates=false&schemaDrift=false&nullFields=false&serverError=false&expiredToken=false&futureDates=false'
done          # one of the ten is 429

# Token expiry: the provider counts per token string, so a fresh token
# survives exactly 15 requests
for i in $(seq 1 17); do
  curl -s -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer my-token' \
    'localhost:3000/api/mock-provider/invoices?expiredToken=true'
done          # the last ones are 401
```

Stage 2 — ingestion:

```bash
set -a; . ./.env.local; set +a     # picks up INGESTION_TRIGGER_SECRET

# Unauthenticated: 401. The route writes with the service role and takes
# org_id from its body, so this check is the only thing standing between a
# caller and any tenant.
curl -s -X POST localhost:3000/api/ingestion/run \
  -H 'content-type: application/json' \
  -d '{"org_id":"00000000-0000-4000-8000-000000000001"}' -w '\n%{http_code}\n'

# Authenticated run
curl -s -X POST localhost:3000/api/ingestion/run \
  -H 'content-type: application/json' \
  -H "x-ingestion-secret: $INGESTION_TRIGGER_SECRET" \
  -H "x-correlation-id: $(uuidgen)" \
  -d '{"org_id":"00000000-0000-4000-8000-000000000001"}' | jq
```

The response carries the counters that matter:

```json
{
  "status": "succeeded",
  "rows_read": 120, "rows_written": 108,
  "rows_quarantined": 12, "rows_deduplicated": 0,
  "counters_balanced": true
}
```

`counters_balanced` is the "zero silent drops" guarantee made checkable:
`rows_read` must equal `written + quarantined + deduplicated`. If it is
`false`, a record went somewhere unaccounted for, and that is a bug
regardless of what `status` says.

Run the same command a second time. Because the run resumed from the first
run's cursor there is nothing new upstream, so it reads nothing. To prove
idempotency instead of exhaustion, rewind the cursor first:

```bash
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  -c "update pipeline_runs set cursor_to = null
      where org_id = '00000000-0000-4000-8000-000000000001'"
```

and re-run: the invoice count stays put and `rows_deduplicated` climbs.

### In Postman

The same checks as a collection, for when watching the traffic is more
useful than a pass/fail line:

```bash
make postman-env     # writes postman/LedgerLens.local.postman_environment.json
```

Then in Postman: **Import** (⌘O) →  paste the contents of
`postman/LedgerLens.postman_collection.json`, import, and repeat for the
generated environment file. Select **LedgerLens — local** in the
environment picker and use the **Collection Runner** — several requests
call themselves in a loop via `pm.execution.setNextRequest`, which only
works there, and later requests depend on variables earlier ones set.

The environment file is generated rather than committed because it holds
the local stack's `service_role` and `anon` keys. They are fixed,
publicly documented development values, but a committed file with a key
named `service_role` is a habit worth not forming. The template beside it
is what's in git.

To run it headless — useful for checking the collection still works after
an API change:

```bash
bunx --bun newman run postman/LedgerLens.postman_collection.json \
  -e postman/LedgerLens.local.postman_environment.json
```

The collection overlaps the Playwright suite deliberately, but reaches one
thing the shell version cannot: a real GoTrue sign-in, so RLS is
exercised through a genuine JWT rather than an impersonated role. That
difference is not academic — it is what caught the seed writing NULL into
`auth.users.confirmation_token`, which made every sign-in fail with a 500
while every `set local role` check kept passing. `tests/rls.spec.ts` now
covers both paths for the same reason.

### Automated: the Playwright suite

Everything above, asserted:

```bash
make e2e                                    # every spec
make e2e ARGS=tests/stage3-data-quality.spec.ts
bun run test:e2e:ui                         # the interactive runner
make verify                                 # make check, then the suite
```

Playwright starts the dev server itself if one is not already running, and
reuses yours if it is. `.env.local` is read by `playwright.config.ts`, so
no secret has to be exported by hand; `BASE_URL` and `DB_URL` override the
defaults.

| Spec | What it covers |
|---|---|
| `tests/stage1-mock-provider.spec.ts` | Each chaos flag in isolation, and a cursor walk that reconciles against `/summary` |
| `tests/stage2-ingestion.spec.ts` | Trigger auth, counter balance, idempotency, tenant-scoped idempotency, orphans, privilege grants |
| `tests/stage3-data-quality.spec.ts` | All four checks, both green and red, plus the threshold boundaries |
| `tests/rls.spec.ts` | Tenant isolation through Postgres *and* through PostgREST as a signed-in user |

`tests/helpers/db.ts` holds the database side: `whatIf()` runs a mutation
inside a transaction that is always rolled back, which is how a check is
proven able to go red without leaving the database changed, and `asUser()`
runs a query as the `authenticated` role with a real JWT claim.

Every check is asserted both ways — that it passes on healthy data and
that it fails on broken data. A check that cannot go red is decoration,
and this suite has caught three of those in itself.

The database helpers refuse to run against anything but a loopback host.
They truncate tables, and `DB_URL` is an overridable environment variable;
the obvious way to "check the hosted project quickly" would otherwise
destroy real data.

Each new stage adds a spec file. A stage that cannot be exercised from
outside the process is a stage whose seams are in the wrong place.

---

## Connecting IntelliJ IDEA (or DataGrip)

**Local stack** — *View → Tool Windows → Database → + → Data Source → PostgreSQL*:

| Field | Value |
|---|---|
| Host | `127.0.0.1` |
| Port | `54322` |
| Database | `postgres` |
| User | `postgres` |
| Password | `postgres` |
| URL | `jdbc:postgresql://127.0.0.1:54322/postgres` |

Hit **Test Connection**, then **Apply**. The password really is `postgres`
— the local stack ships with fixed development credentials, and it only
listens on loopback.

Two settings worth changing after connecting:

- **Schemas** tab: tick `public` *and* `auth`. The seed's users live in
  `auth`, and `auth.uid()` is what every RLS policy keys off — with `auth`
  hidden, half the interesting state is invisible.
- The `postgres` superuser **bypasses RLS**. That is convenient for
  looking around and useless for verifying isolation. To see what a real
  user sees, impersonate one in the SQL console:

  ```sql
  begin;
  set local role authenticated;
  set local request.jwt.claims =
    '{"sub":"00000000-0000-4000-9000-000000000002","role":"authenticated"}';

  -- Globex's user querying Acme's invoices: zero rows, no error
  select count(*) from invoices
   where org_id = '00000000-0000-4000-8000-000000000001';
  rollback;
  ```

  Zero rows is the pass condition. An error, or any rows, is a failure —
  RLS must make other tenants invisible, not merely forbidden.

`.idea/` is gitignored, so the data source stays local to your machine.

**Hosted project** — same dialog, but the connection details come from the
Supabase dashboard under *Project Settings → Database*. Two things to know
before you go there:

- The database password is **not recoverable**. It was shown once at
  project creation; if you no longer have it, the dashboard's *Reset
  database password* is the only way forward, and resetting it invalidates
  any existing direct connection string.
- Prefer the **session pooler** connection string the dashboard offers
  (port `5432` via the pooler host) over a direct connection. IPv4-only
  networks cannot reach the direct host at all.

Treat the hosted database as production even though it is a pet project:
connect read-only where you can, and make schema changes only through
`supabase/migrations/` so local and hosted never drift.

---

## Syncing schema changes to the hosted project

Local is where migrations get written and proven; the hosted project only
ever receives them. Nothing is ever changed there by hand — a hand-edit is
a divergence no `db reset` can reproduce, which is the exact failure mode
the grants migration exists to fix.

```bash
supabase link --project-ref nhvtzdufsjtlwidnfkzo   # prompts for the database password
supabase migration list                            # local vs remote, side by side
supabase db push                                   # shows a plan, then applies
```

`supabase link` is the step that needs the hosted database password (the
same one IntelliJ needs). `db push` applies only migrations whose version
is not already recorded remotely, so re-editing an already-applied
migration file does **not** re-run it — if the fix has to reach the hosted
project, it needs its own new migration.

Verify afterwards that the two databases agree:

```sql
-- against the hosted project; anon should hold nothing
select grantee, table_name, privilege_type
  from information_schema.role_table_grants
 where table_schema = 'public'
   and grantee in ('anon', 'authenticated', 'service_role')
 order by table_name, grantee;
```

`tests/stage2-ingestion.spec.ts` asserts the same thing locally, so the
two can be compared directly. `supabase db dump -f before.sql` before a push and
again after gives a diffable record of what actually changed — more
reliable than reading the migration and assuming, and it needs no
password of its own once `supabase link` has run.

---

## Resetting

```bash
supabase db reset          # schema + seed back to a known state, data gone
supabase stop              # stop containers, keep the data volume
supabase stop --no-backup  # stop and discard local data entirely
```

`supabase db reset` is cheap and the right reflex whenever local data gets
into a state you cannot explain. Nothing in it is precious — that is the
whole point of testing here rather than against the hosted project.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `supabase start` hangs or errors immediately | Docker Desktop is not running | start Docker, wait for the whale icon, retry |
| Route returns `SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set` | `.env.local` missing or the dev server started before it existed | write `.env.local`, restart `bun run dev` |
| `POST /api/ingestion/run` returns 401 with the header set | `INGESTION_TRIGGER_SECRET` differs between `.env.local` and your shell | re-source `.env.local`, restart the dev server |
| Ingestion run succeeds but writes nothing | the cursor is already at the end of the dataset | null out `cursor_to` (see above) or `supabase db reset` |
| `psql: connection refused` on 54322 | stack is stopped | `supabase start` |
| Port already in use on start | another Supabase project is running | `supabase stop` in that project, or change ports in `supabase/config.toml` |
| `make check` says deno went unchecked | Deno is not installed | install Deno, or accept the gap knowingly — it is reported, not hidden |
