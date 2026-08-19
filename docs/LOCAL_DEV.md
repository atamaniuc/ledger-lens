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
- [Verifying by hand](#verifying-by-hand) — [browser](#in-the-browser), [curl](#with-curl), [the webhook](#the-webhook-edge-function), [Playwright](#automated-the-playwright-suite)
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
MOCK_PROVIDER_SEED=42
```

Reprint the stack's values at any time with `task dev-status`.

`supabase/.env` is a different file doing a different job: it holds the
secrets `supabase start` hands to the **Edge Functions container**, wired
through `[edge_runtime.secrets]` in `supabase/config.toml`. It has to exist
before the stack starts — the container reads its environment once — and
`WEBHOOK_SHARED_SECRET` must be identical in both files. The caller reads it
from `.env.local`; the function checks the one it was given here. If you
wrote it after starting the stack, `task dev-down && task dev-start` picks
it up without touching the data.

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

```bash
task check              # typecheck + lint + unit tests + deno check
task types-check        # database.types.ts still matches the schema
task e2e                # Playwright: the running app against a running database
task verify             # check, types-check, and e2e, in that order
task dev-down           # when done; `task dev-nuke` also discards local data
```

`task check` and `task e2e` answer different questions. `task check` proves
the pure logic is right — typecheck, lint, and unit tests all run inside the
`dev` container (Bun and Linux, matching what's deployed) rather than
whatever the host happens to have installed, plus `deno-check`, which stays
on the host (the image has no Deno). `task e2e` proves the running app talks
to a running Postgres correctly — HTTP status codes, RLS under a real JWT,
idempotency across two actual runs; it runs on the host, since the image
doesn't carry Playwright's browser binaries. `task types-check` needs the
stack too (to introspect the schema), which is why it's a `verify` step
rather than a `check` one. A stage is not verified until all three are
green, which is what `task verify` runs.

**Everything containerised needs the stack running first**, even `task
typecheck` — `docker compose run`'s `dev` service joins
`supabase_network_t1`, which only exists once `supabase start` has created
it, whether or not the command itself touches the database. `task
check:watch` re-runs the pure-logic gate on every save, now as three
separate `docker compose run` containers instead of three in-process calls —
measured, `task check` takes ~40s containerised against ~8s for the same
three commands run bare on the host. A real cost, not "a few seconds,"
accepted for `tsc`/`eslint`/`bun test` running against the exact environment
that gets deployed rather than whatever's on the host.

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

## Running the app in Docker

There is one dev loop and one deployed artifact, both containerised — no
host bun/next process is part of the normal flow anymore:

| Mode | Command | What it's for |
|---|---|---|
| Dev loop | `task dev` (foreground) / `task docker-dev` (same thing, detached) | Hot reload + IDE debug (`localhost:9230`), inside the same image and network the deployed app uses. `task typecheck`/`lint`/`test`/`build`/`start` all run here too, each as a one-off `docker compose run`. |
| Deployed artifact | `task docker-up` | The actual production build — traced `.next/standalone`, non-root user, no dev toolchain inside it at all. |

```bash
task dev-start          # the stack — creates the network everything below needs
task dev                # hot reload + debug, foreground (Ctrl+C stops it)
task docker-dev-sh      # a shell inside a running `dev` container
task docker-dev-down    # stop and remove it, if started via docker-dev
```

```bash
task docker-up          # the production build, containerised
task docker-logs        # tail it
task docker-down        # stop and remove it (the stack is untouched)
```

Only one of `task dev`/`task docker-dev` and `task docker-up` should hold
port 3000 at a time. `APP_PORT=3001 task docker-up` moves one aside.

Several things are deliberately arranged this way:

- **The stack is not in `compose.yaml`.** `supabase start` owns those twelve
  containers and their versions travel with `supabase/config.toml`; a second
  definition here would be a copy that drifts from the one migrations and
  `db reset` are proven against. The network is declared `external`, so
  `docker compose down` can never take the database with it. See
  [ADR 0006](../.claude/adr/0006-the-app-is-containerised-the-supabase-stack-is-not-duplicated.md).
- **`SUPABASE_URL` is overridden to `http://kong:8000`** for both the `dev`
  and the `app` service. Inside the network the gateway is a service name;
  `127.0.0.1` in a container is the container itself. The rest of the
  environment comes from the same `.env.local` the host process reads.
- **`dev` bind-mounts the source; `app` does not.** `compose.yaml`'s `dev`
  service mounts `.` straight into the container — two *named* volumes
  (not anonymous) shadow the container's own `node_modules` and `.next`, so
  the host's (macOS) versions never overwrite the Linux-built native deps
  (`sharp`, `unrs-resolver`) the image already installed, and so `task
  build`'s output is still there for `task start` to read even though
  they're two separate `docker compose run` invocations. `app`'s job is the
  opposite: what runs there is exactly what `docker build` traced and
  copied in, nothing live. ADR 0006 originally rejected the bind-mounted
  form "for now" — adopted once IDE-attach debugging needed a reachable
  inspector port and running the toolchain identically in-container became
  worth the bind-mount's slower I/O on macOS. Named, not anonymous, has its
  own cost: a named volume is populated from the image only while empty, so
  `bun add`ing a dependency on the host needs `task dev-volumes-reset` — a
  rebuilt image alone does not reach an already-populated volume.
- **`dev` runs as a non-root user; both containers hold the same secret
  either way.** Same reasoning `runner` already states for itself — the
  service-role key is present, so a process escape shouldn't also be a root
  shell — extended here since `dev` adds a published inspector and a
  read-write mount of the whole repo on top. That mount is broader than
  what the image ever contains: `.dockerignore` excludes `.git`,
  `supabase/.env`, and `interview-preps/` from the *build*, but all three
  are reachable at runtime through the bind mount. Accepted for a
  local-only container; wouldn't be if this image ever left the machine.
- **`task build` runs under real Node, not Bun, inside the `dev`
  container.** `next build` segfaults under Bun on Alpine — the same crash
  that's why the production `build` Dockerfile stage runs on
  `node:22-alpine` rather than the Bun-based `deps`. The `dev` stage
  installs real Node (`apk add nodejs`) specifically for this one command;
  `typecheck`/`lint`/`test`/`start` all run fine under Bun.
- **`typecheck` runs `next typegen` first.** `tsc` depends on ambient types
  (`LayoutProps`, etc.) Next.js generates into `.next/types/**` as a side
  effect of `next dev`/`next build` — since the named `.next` volume can
  start empty, `typecheck` generates them itself rather than assuming
  something else already ran first.

The image has four stages relevant here: `deps` (Bun installs dependencies,
real Node added on top for `dev`), `dev` (built on `deps`, no source copy —
bind-mounted instead), and `build`/`runner` (Node runs `next build` for the
*deployed* image, then the runtime stage carries only `.next/standalone`,
traced, under a non-root user).

---

## Debugging in IntelliJ IDEA

Two debug targets, two different ports, on purpose — so both can run and be
attached to at the same time without a clash:

| Target | Command | Attach to |
|---|---|---|
| Next.js app | `task dev` / `task docker-dev` | `localhost:9230` — `compose.yaml` runs `bun --inspect=0.0.0.0:9230 node_modules/next/dist/bin/next dev` inside the `dev` container, published loopback-only |
| Edge Function (`provider-webhook`) | `task dev-start` (running whenever the stack is up) | `localhost:8083` — `inspector_port` in `supabase/config.toml` |

A raw `bun run dev` still works if you ever run it directly on the host,
bypassing Task entirely (not the normal flow) — `package.json`'s own script
listens on `127.0.0.1:6499`, Bun's own default inspector port, deliberately
different from `9230` so the two would never collide if both happened to run
at once.

*Run → Edit Configurations → + → Attach to Node.js/Chrome*, **Host**
`localhost` (or `127.0.0.1` — see the note below if `localhost` doesn't
connect), **Port** whichever of the above applies. Set a breakpoint,
trigger the route (curl, the browser, or a Playwright spec), and it hits —
`task docker-dev`'s loopback-only port publish makes the container
indistinguishable from a host process at the network level.

**Why `package.json`'s script looks the way it does:**
`bun --inspect=127.0.0.1:6499 node_modules/next/dist/bin/next dev`, not the
more obvious `NODE_OPTIONS='--inspect' next dev`. The obvious form does
nothing under Bun — `NODE_OPTIONS` is a Node convention Bun's own inspector
doesn't read, confirmed empirically (no port ever opens, host or container).
The `--inspect` flag also has to apply to `next`'s own file path, not to
`bun run dev`: `bun run <script>` re-executes the script line as a new
process, which drops a `--inspect` CLI flag given to the outer `bun`
invocation. `6499` is Bun's own default inspector port (`ws://localhost:...`
if you omit the host/port entirely) — pinned here to `127.0.0.1` explicitly
because Bun's bare default binds IPv6 loopback only, which some tools
(including a plain `curl http://localhost:6499`, depending on resolver
order) fail to reach even though it's working correctly.

`task docker-dev` needs a different mechanism for the same reason
`NODE_OPTIONS` doesn't work: `compose.yaml` can't just override an
environment variable, because neither `NODE_OPTIONS` nor `BUN_INSPECT`
(Bun's own env-var form) survives the `bun run` → script indirection
without breaking — `BUN_INSPECT` gets inherited by *both* the wrapper
process and the script it spawns, so both try to bind the same port and the
second one crashes (`EADDRINUSE`). `compose.yaml` instead overrides the
whole `command:` to invoke `next`'s file path directly under
`bun --inspect=0.0.0.0:...`, the same shape as `package.json`'s script, just
with a different bind address — one process, the flag actually takes.

The Edge Function's inspector is the same V8 protocol Deno exposes for any
target; it's separate from the IDE's Deno *language* support (import
resolution, `deno.json` — see the webhook section above), which doesn't set
up debugging on its own.

`0.0.0.0` only ever appears in `compose.yaml`'s override, never in
`package.json`. Putting it in the script itself would bind a **host** `bun
run dev` to `0.0.0.0` too, putting a code-execution-capable debugger on
whatever network the laptop is on — Docker's loopback-only port publish is
what makes `0.0.0.0` safe *inside* the `dev` container specifically.

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
| Route returns `SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set` | `.env.local` missing or the dev container started before it existed | write `.env.local`, restart `task dev` |
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
| `task dev`/`task docker-dev` fails to bind port 3000 | `task docker-up` is already holding it, or a previous `dev` container is still up | `task docker-dev-down`, or `APP_PORT=3001 task dev` |
| IDE can't attach on 9230 | `task dev`/`task docker-dev` isn't running | `task docker-ps` to confirm it's up; see "Debugging in IntelliJ IDEA" |
| `task typecheck`/`lint`/`test`/`build` fails with `network supabase_network_t1 not found` | the stack isn't running — these are now containerised and need the network `supabase start` creates, even though they touch no database | `task dev-start` first |
| `task dev`/`docker-dev`/`typecheck`/etc. run stale code after `bun add <package>` on the host | the container's `node_modules` is a *named* volume — populated from the image only while empty, so rebuilding the image (`--build`) does **not** refresh it once it has content | `task dev-volumes-reset`, then start again |
| `task start` fails with `port is already allocated` | it publishes the app port explicitly; something else (`task dev`/`docker-dev`) already holds it | `task docker-dev-down` first, or `APP_PORT=3001 task start` |
| `task types-check` fails | `lib/supabase/database.types.ts` is stale against the schema | `task types`, review the diff, commit it |
