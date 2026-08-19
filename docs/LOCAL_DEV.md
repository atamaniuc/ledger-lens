# Local Development

How to run LedgerLens on your machine, verify a stage by hand (browser +
curl), and point a SQL client such as IntelliJ IDEA at the database.

Everything here targets the **local** Supabase stack, not the hosted
project. The local stack is a full Postgres + Auth + Studio running in
Docker, seeded from `supabase/seed.sql`, and it is the right place to test
a stage: it can be reset to a known state in seconds, its credentials are
non-secret by design, and a mistake there costs nothing.

## Contents

- [Prerequisites](#prerequisites)
- [One-time setup](#one-time-setup)
- [Daily loop](#daily-loop)
- [Local URLs](#local-urls)
- [Verifying by hand](#verifying-by-hand) — [browser](#in-the-browser), [curl](#with-curl), [the webhook](#the-webhook-edge-function), [the RAG index](#the-rag-index), [Playwright](#automated-the-playwright-suite)
- [Running the app in Docker](#running-the-app-in-docker)
- [Debugging in IntelliJ IDEA](#debugging-in-intellij-idea)
- [Connecting IntelliJ IDEA (or DataGrip)](#connecting-intellij-idea-or-datagrip)
- [Syncing schema changes to the hosted project](#syncing-schema-changes-to-the-hosted-project)

Read it by section — it is a runbook, not a document to read front to back.

---

## Prerequisites

| Tool | Why | Check |
|---|---|---|
| [Docker Desktop](https://docs.docker.com/desktop/) | runs the local Supabase stack | `docker info` |
| [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started) | starts/resets the stack, applies migrations | `supabase --version` |
| [Bun](https://bun.sh) | package manager (`task install`, host-side `node_modules` for the IDE) | `bun --version` |
| `psql` | ad-hoc queries; the test suite talks to Postgres directly | `psql --version` |
| [Deno](https://deno.land) | type-checks `supabase/functions/`, which `tsc` cannot — `task check` skips this gate loudly when absent | `deno --version` |
| [Task](https://taskfile.dev) | runs every command in this document | `task --version` |

Everything is driven through [Task](https://taskfile.dev). Run `task` with
no arguments for the full grouped list, `task --list` for the same set
alphabetically, and `task completion` for the shell-completion setup.

---

## One-time setup

```bash
task install                             # bun install
cp supabase/.env.example supabase/.env   # before the stack starts — see below
task dev-up                              # starts the stack (first run pulls
                                         # several GB), then applies every
                                         # migration and the seed
task env                                 # writes .env.local from the stack
```

`task env` reads the stack's own URLs and keys and writes them out, so the
service-role key is never hand-copied and cannot go stale. It refuses to
overwrite an existing `.env.local`; delete the file first if you want it
regenerated. The result looks like this (`.env.example` documents every
variable, including the optional ones):

```bash
# .env.local
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_SERVICE_ROLE_KEY=<the "service_role key" the stack printed>
INGESTION_TRIGGER_SECRET=local-dev-ingestion-secret
WEBHOOK_SHARED_SECRET=local-dev-webhook-secret
EMBED_SHARED_SECRET=local-dev-embed-secret
MOCK_PROVIDER_SEED=42
```

Reprint the stack's values at any time with `task dev-status`.

`supabase/.env` is a different file doing a different job: it holds the
secrets `supabase start` hands to the **Edge Functions container**, wired
through `[edge_runtime.secrets]` in `supabase/config.toml`. It has to exist
before the stack starts — the container reads its environment once — and
`WEBHOOK_SHARED_SECRET` and `EMBED_SHARED_SECRET` must each be identical in
both files. The caller reads it
from `.env.local`; the function checks the one it was given here. If you
wrote it after starting the stack, `task dev-down && task dev-start` picks
it up without touching the data. A brand-new function *directory* needs the
same restart even with hot reload on: the Edge Functions container binds its
list of functions when it starts, and until then the gateway answers
`Function not found`.

The local `service_role` key is a fixed, publicly documented development
key — it is not a secret and grants nothing outside your machine. The
hosted project's key is a real secret and must never appear in a file that
git tracks. `.env.local` is gitignored precisely so the same variable name
can hold either.

`task dev-up` ends by running `supabase db reset` — it drops the database,
re-applies every migration in order, and runs `supabase/seed.sql`. Run it on
its own with `task dev-reset` after writing a migration.

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
task dev-start          # if the stack is not already running (keeps data)
task dev                # the Next.js dev server on http://localhost:3000
```

The app runs on this machine, not in a container. Docker is needed for the
Supabase stack behind it — `task dev` says so if the stack is down.

```bash
task check              # typecheck + lint + unit tests + deno check
task types-check        # database.types.ts still matches the schema
task e2e                # Playwright: the running app against a running database
task verify             # check, types-check, and e2e, in that order
task dev-down           # when done; `task dev-nuke` also discards local data
```

`task check` and `task e2e` answer different questions. `task check` proves
the pure logic is right — typecheck, lint, unit tests and `deno check`, all
on this machine, needing **nothing running**: no Docker, no Supabase stack.
It takes about 14 seconds, which is why `task check:watch` re-running it on
every save is practical. `task e2e` proves the running app talks to a
running Postgres correctly — HTTP status codes, RLS under a real JWT,
idempotency across two actual runs — so it needs the stack and the app.
`task types-check` needs the stack too, to introspect the schema, which is
why it belongs to `verify` rather than to `check`. A stage is not verified
until all three are green, which is what `task verify` runs.

Which runtime does what, since there are four and it is otherwise a guess:

| Runtime | Used for |
|---|---|
| Docker | The Supabase stack, and nothing else that is required |
| Bun | Installing dependencies, unit tests, and running the lint/typecheck scripts |
| Node 22+ | `task dev`'s debuggable server, `task build`, `task start` |
| Deno | `supabase/functions/**` only — `task deno-check` |

`task` on its own prints every task, grouped and coloured; `task --list`
prints the same set alphabetically. The destructive ones (`dev-up`,
`dev-reset`, `dev-nuke`) prompt before running — pass `--yes` to skip that
in a script. The ones that need a running stack check for it and say what
to run instead of failing with a connection error.

Handy extras:

```bash
task psql               # a psql shell on the local database
task studio             # Supabase Studio in the browser
task dev-logs SERVICE=auth   # a stack container's logs (db, auth, rest, edge_runtime, kong)
task e2e -- tests/rls.spec.ts
task types               # regenerate lib/supabase/database.types.ts after a migration
task clean              # build output and test artifacts
```

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

### The webhook (Edge Function)

Stage 2's push path is a Deno Edge Function, served by the local stack's own
`edge-runtime` container at `/functions/v1/provider-webhook`. Two credentials
do two different jobs: the API gateway checks a Supabase key before routing
at all, and the function checks `x-webhook-secret` before it writes anything.

That container is a deliberate choice, not the only option — `supabase
functions serve` is a separate, lighter CLI-only path that doesn't need
`supabase start` at all. It's not used here because `docs/DEPLOYMENT.md`'s
Pulumi program deploys this function to Supabase's hosted platform via
`supabase functions deploy`, which runs functions on that same open-source
`edge-runtime`. Local and prod already share the engine; `functions serve`
would be a second, unproven code path for no gain.

```bash
set -a; . ./.env.local; set +a
ANON_KEY="$(supabase status -o json | jq -r .ANON_KEY)"
FUNCTIONS_URL="$(supabase status -o json | jq -r .FUNCTIONS_URL)"

curl -sS -X POST "$FUNCTIONS_URL/provider-webhook" \
  -H "authorization: Bearer $ANON_KEY" \
  -H "x-webhook-secret: $WEBHOOK_SHARED_SECRET" \
  -H 'content-type: application/json' \
  -d '{
    "org_id": "00000000-0000-4000-8000-000000000001",
    "event": { "external_id": "inv-manual-1", "customer": "Acme Corp",
               "amount": 4999, "currency": "USD", "status": "open",
               "issued_at": "2026-08-15" }
  }' | jq
```

The first call returns `"status":"succeeded"`, the second the same body with
`"status":"duplicate"` and no second invoice — the push path calls the same
`ingest_raw_event` routine the polling path does, so idempotency is one
guarantee rather than two implementations of one. Send `"customer": null` to
see `"status":"quarantined"`, and a wrong `x-webhook-secret` to see a 401
that leaves no `pipeline_runs` row behind.

If every call returns 401 with a correct secret, the container does not have
one: `supabase/.env` is missing, or the stack was started before it existed.
Write the file and `task dev-down && task dev-start`. To confirm:

```bash
docker exec supabase_edge_runtime_t1 env | grep -c WEBHOOK_SHARED_SECRET   # 1
```

`tests/stage2-webhook.spec.ts` asserts all of the above, including the two cases
that are tedious by hand: that a rejected call writes nothing at all, and
that the run is recorded as `kind='webhook'` rather than `'incremental'`
(filed under the wrong kind, a cursorless webhook run resets the poller to
offset 0).

The function is excluded from `tsconfig.json` and from ESLint — `npm:`
specifiers, Deno globals and `.ts` import extensions do not parse under the
Next.js app's configuration — so `deno check` is what covers it, and
`task check` runs it. If your IDE reports unresolved imports in
`supabase/functions/`, that is the same split: enable its Deno support for
that directory only, pointed at
`supabase/functions/provider-webhook/deno.json`. In IntelliJ IDEA and
WebStorm that is *Settings → Languages & Frameworks → Deno*.

### The RAG index

Stage 5's corpus is two things: the documents the seed writes, and every
invoice ingestion has produced. `task index` chunks both, embeds each chunk
through the `embed` Edge Function, and writes `chunks`.

```bash
task index                  # every tenant
task index -- --org 00000000-0000-4000-8000-000000000001
```

It is idempotent, and that is worth checking rather than trusting: run it
twice and the second run reports `chunksInserted: 0` with
`embeddingsComputed: 0`. Only a chunk whose content hash changed is
re-embedded, and a source that got shorter has its tail chunks deleted.

Embedding is the slow part — around 45 seconds for a full corpus of ~360
invoice chunks on a laptop, because the Edge Runtime's per-request CPU budget
caps a batch at eight texts. A re-run over an unchanged corpus takes about a
second.

Ingest before you index, or there is nothing but the seeded documents to
retrieve:

```bash
curl -s -X POST http://localhost:3000/api/ingestion/run \
  -H "x-ingestion-secret: $INGESTION_TRIGGER_SECRET" \
  -H 'content-type: application/json' \
  -d '{"org_id":"00000000-0000-4000-8000-000000000001"}'
task index
```

One of the seeded documents is a **deliberate prompt-injection fixture**
(`Vendor onboarding note`). It is retrievable on purpose: Stage 5's safety
test asserts the agent does nothing harmful with it, because no tool in the
system can send, write or reach the network. Do not remove it.

---

### Automated: the Playwright suite

Everything above, asserted:

```bash
task e2e                                    # every spec
task e2e -- tests/stage3-data-quality.spec.ts
task e2e:ui                                 # the interactive runner
task e2e:report                             # the last HTML report
task verify                                 # task check, then the suite
```

Under the hood every one of those is `bunx playwright test`, which is also
the direct form if you want the CLI's own flags:

```bash
bunx playwright test --grep reconciliation
bunx playwright test tests/stage2-webhook.spec.ts --debug
```

`bunx` hands off to Playwright's own CLI, which runs under Node — the
runtime the test runner and its browser drivers target. Nothing here needs
Bun to execute the suite, and delegating avoids a class of failures that
have nothing to do with this code.

### Automated: the evals

```bash
task evals              # the gate CI runs
task evals -- --verbose # print what each retrieval case actually returned
```

Needs the stack running and the index built (`task index`). It scores
`evals/dataset.jsonl` against `evals/thresholds.json` and exits non-zero when
a threshold is breached. Without an `ANTHROPIC_API_KEY` the two
model-dependent metrics report `skip` — they are never counted as passes.

Playwright starts the dev server itself if one is not already running, and
reuses yours if it is. `.env.local` is read by `playwright.config.ts`, so
no secret has to be exported by hand; `BASE_URL` and `DB_URL` override the
defaults.

| Spec | What it covers |
|---|---|
| `tests/stage1-mock-provider.spec.ts` | Each chaos flag in isolation, and a cursor walk that reconciles against `/summary` |
| `tests/stage2-ingestion.spec.ts` | Trigger auth, counter balance, idempotency, tenant-scoped idempotency, orphans, privilege grants |
| `tests/stage3-data-quality.spec.ts` | All four checks, both green and red, plus the threshold boundaries |
| `tests/stage2-webhook.spec.ts` | The Edge Function: accepted, deduplicated, quarantined, wrong secret, malformed body |
| `tests/rls.spec.ts` | Tenant isolation through Postgres *and* through PostgREST as a signed-in user |

`tests/helpers/stack.ts` reads the local stack's URLs and keys from
`supabase status` rather than from a committed file, so a spec cannot pass
against a stack that has moved ports or rotated its demo keys.
`tests/helpers/db.ts` holds the database side: `whatIf()` runs a mutation
inside a transaction that is always rolled back, which is how a check is
proven able to go red without leaving the database changed, and `asUser()`
runs a query as the `authenticated` role with a real JWT claim.

Every check is asserted both ways — that it passes on healthy data and
that it fails on broken data. A check that cannot go red is decoration,
and this suite has caught three of those in itself.

RLS is likewise checked twice: by impersonating the `authenticated` role in
Postgres, and by signing in through GoTrue for real. The second is not
redundant — impersonation never goes near the auth service, and it was the
sign-in path that caught the seed writing NULL into
`auth.users.confirmation_token`, which made every real sign-in fail with a
500 while every impersonated check kept passing.

The database helpers refuse to run against anything but a loopback host.
They truncate tables, and `DB_URL` is an overridable environment variable;
the obvious way to "check the hosted project quickly" would otherwise
destroy real data.

Each new stage adds a spec file. A stage that cannot be exercised from
outside the process is a stage whose seams are in the wrong place.

---

## The optional container smoke check

The app is developed on this machine. The container image below is a
separate, occasional check — not a mode of working.

```bash
task docker-build       # build the production image (no stack needed)
task docker-up          # run it on the stack's network
task docker-logs        # tail it
task docker-ps          # is it up
task docker-sh          # a shell inside it
task docker-down        # stop and remove it (the stack is untouched)
```

What it is good for: the production build, running in Linux, under a
non-root user, with only the traced `.next/standalone` output present. That
catches container-shaped mistakes — the recurring one being `127.0.0.1`,
which inside a container means the container, not the machine.

What it is **not**: the environment Vercel runs. Vercel builds and serves
the deployed app from Next.js's own output, so a green run here proves the
build works in *a* container and nothing stronger. See
[ADR 0006](../.claude/adr/0006-the-app-is-containerised-the-supabase-stack-is-not-duplicated.md).

Only one of `task dev` and `task docker-up` should hold port 3000 at a time.
`APP_PORT=3001 task docker-up` moves one aside.

Two details worth knowing:

- **The Supabase stack is not in `compose.yaml`.** `supabase start` owns
  those containers and their versions travel with `supabase/config.toml`; a
  second definition would be a copy that drifts from the one migrations and
  `db reset` are proven against. The network is declared `external`, so
  `docker compose down` can never take the database with it.
- **`SUPABASE_URL` is overridden to `http://kong:8000`** for the `app`
  service, because inside the network the gateway is a service name. The
  rest of the environment comes from the same `.env.local` this machine's
  processes read.

The image has three stages: `deps` (Bun installs from `bun.lock`), `build`
(Node 22 runs `next build` — `next build` segfaults under Bun on Alpine),
and `runner` (Node 22 serving `.next/standalone` as a non-root user, with
neither Bun nor the full dependency tree present).

---

## Debugging in IntelliJ IDEA

Two debug targets, two different ports, so both can be attached to at once
without a clash:

| Target | Command | Attach to |
|---|---|---|
| Next.js app | `task dev` | `127.0.0.1:9231` — see the note below on why not 9230 |
| Edge Function (`provider-webhook`) | `task dev-start` (running whenever the stack is up) | `127.0.0.1:8083` — `inspector_port` in `supabase/config.toml` |

*Run → Edit Configurations → + → Attach to Node.js/Chrome*, **Host**
`127.0.0.1`, **Port** whichever of the two applies. Set a breakpoint, trigger
the route (curl, the browser, or a Playwright spec), and it hits.

**Why 9231 and not 9230.** `task dev` runs
`node --inspect=127.0.0.1:9230 node_modules/next/dist/bin/next dev`, which
puts an inspector on the `next` **CLI** process. Next then forks the server
that actually handles requests and hands it the next free port, printing it
on startup:

```
- Debugger port: 9231
```

Route handlers and Server Components run in that child. Attaching to 9230
connects to the launcher, which never serves a request, and every breakpoint
stays grey. Both ports answer `/json/list`, so the IDE will happily connect
to the wrong one — check the titles if in doubt:

```bash
curl -s http://127.0.0.1:9230/json/list   # …/next/dist/bin/next        — the launcher
curl -s http://127.0.0.1:9231/json/list   # …/server/lib/start-server.js — the server
```

A `Starting inspector on 127.0.0.1:9231 failed: address already in use` line
in the startup output is expected noise: a third Next worker asks for the
same port and does without one. The server's inspector is unaffected.

**Why `task dev` runs Node and not Bun.** IntelliJ's Node.js attach
configuration finds its target by asking the inspector for `/json/list`.
Bun's inspector answers `/json/version` — advertising CDP 1.3 — but returns
an **empty** `/json/list`, so the IDE has nothing to attach to. Node's V8
inspector is the protocol that configuration actually speaks. Checked
directly rather than inferred:

```bash
node --inspect=127.0.0.1:9241 -e "setTimeout(()=>{},4000)" &
curl -s http://127.0.0.1:9241/json/list      # one target, with a webSocketDebuggerUrl

bun  --inspect=127.0.0.1:9242 -e "setTimeout(()=>{},4000)" &
curl -s http://127.0.0.1:9242/json/list      # empty
```

`task dev:bun` runs the same dev server under Bun for when start-up speed
matters more than a debugger. Its inspector is reachable from Bun's own
tooling (the URL it prints on start), just not from IntelliJ's Node.js
attach. `package.json`'s `dev` script — what `task dev:bun` and Playwright's
`webServer` both run — binds `127.0.0.1:6499`, Bun's default inspector port,
deliberately different from `9230` so the two never collide.

That script is `bun --inspect=127.0.0.1:6499 node_modules/next/dist/bin/next dev`
rather than the more obvious `NODE_OPTIONS='--inspect' next dev`, and the
reason is worth keeping: `NODE_OPTIONS` is a Node convention Bun's inspector
does not read, so the obvious form opens no port at all. The flag also has to
apply to `next`'s own file path — `bun run <script>` re-executes the script
line as a new process and drops a `--inspect` given to the outer `bun`.
`BUN_INSPECT`, the env-var form, fails differently: both the wrapper and the
script it spawns inherit it, so the second one dies with `EADDRINUSE`.

Both inspectors bind loopback only. A debugger is a code-execution channel;
`0.0.0.0` would publish one to whatever network the laptop is on.

The Edge Function's inspector is the V8 protocol Deno exposes for any
target, separate from the IDE's Deno *language* support (import resolution,
`deno.json` — see the webhook section above), which does not set up
debugging on its own.

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

`task dev-up` and `task dev-reset` both drop the database. `task dev-start`
is the one that brings a stopped stack back with its data intact.

```bash
task dev-reset             # schema + seed back to a known state, data gone
task dev-down              # stop containers, keep the data volume
task dev-nuke              # stop and discard local data entirely
```

`task dev-reset` is cheap and the right reflex whenever local data gets
into a state you cannot explain. Nothing in it is precious — that is the
whole point of testing here rather than against the hosted project.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `supabase start` hangs or errors immediately | Docker Desktop is not running | start Docker, wait for the whale icon, retry |
| Route returns `SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set` | `.env.local` is missing, or the server started before it existed | `task env`, then restart `task dev` |
| `POST /api/ingestion/run` returns 401 with the header set | `INGESTION_TRIGGER_SECRET` differs between `.env.local` and your shell | re-source `.env.local`, restart the dev server |
| Ingestion run succeeds but writes nothing | the cursor is already at the end of the dataset | null out `cursor_to` (see above) or `supabase db reset` |
| `psql: connection refused` on 54322 | stack is stopped | `supabase start` |
| Port already in use on start | another Supabase project is running | `supabase stop` in that project, or change ports in `supabase/config.toml` |
| `task check` says deno went unchecked | Deno is not installed | install Deno, or accept the gap knowingly — it is reported, not hidden |
| The webhook returns 401 with the right secret | the Edge Functions container has no `WEBHOOK_SHARED_SECRET` | write `supabase/.env` from its template, then `task dev-down && task dev-start` |
| `task docker-up`: `network supabase_network_t1 not found` | the Supabase stack is not running | `task dev-start` first — the stack creates that network |
| The container starts but every database call fails | `.env.local` is missing, or was written after the container started | `task env`, then `task docker-up` again |
| `supabase start` reports a container unhealthy | a slow or half-stopped previous run | re-run `task dev-start`; if it persists, `task dev-nuke` then `task dev-up` |
| IDE shows unresolved imports in `supabase/functions/` | those files are Deno, and excluded from the app's tsconfig on purpose | enable the IDE's Deno support for that directory only (see the webhook section above) |
| `task dev` fails to bind port 3000 | `task docker-up` or another dev server already holds it | `task docker-down`, or `APP_PORT=3001 task dev` |
| IDE cannot attach, or breakpoints stay grey | attached to 9230 (the `next` launcher) instead of 9231 (the server), or `task dev:bun` is running — Bun's inspector returns an empty `/json/list` | attach to 9231 under `task dev`; see "Debugging in IntelliJ IDEA" |
| `task build` refuses to run | Node is missing, or older than 22 | install Node 22 or newer — the build and the runtime image both need it |
| `git status` shows `next-env.d.ts` changed and you did not touch it | `next typegen` and `next dev` write different type paths into it, so it flips depending on which ran last | harmless; `git checkout -- next-env.d.ts` |
| `task start` fails to bind port 3000 | `task dev` or `task docker-up` already holds it | stop that one, or `APP_PORT=3001 task start` |
| `task types-check` fails | `lib/supabase/database.types.ts` is stale against the schema | `task types`, review the diff, commit it |
