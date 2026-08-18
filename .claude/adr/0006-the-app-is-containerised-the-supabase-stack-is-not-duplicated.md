# 0006: the app is containerised; the Supabase stack is not duplicated

Status: Accepted

## Context

Local development already depends on Docker: `supabase start` runs Postgres,
GoTrue, PostgREST, Kong and the Deno Edge Runtime as twelve containers, with
their image versions pinned by the Supabase CLI and their configuration by
`supabase/config.toml`. The Next.js app, however, ran only as a host process
(`bun run dev`), which left three gaps:

- **The production artifact was never exercised locally.** `bun run dev` runs
  the development server. Nothing in the local loop ever built and started
  the thing that gets deployed, so the first execution of a production build
  happened on the deploy target.
- **Container-specific failures were invisible.** `SUPABASE_URL` is
  `http://127.0.0.1:54321` for a host process and `http://kong:8000` for a
  container; loopback inside a container is the container. That class of
  configuration error can only be found by running in one.
- **"Docker is already here" was true but unused.** The dependency was paid
  for and only the database side benefited from it.

The obvious move — write a Compose file for the whole system — has a real
cost. It would mean a second definition of Postgres, Auth and PostgREST
alongside the CLI's, with their own image tags and their own initialisation.
Migrations, `db reset`, the seed and the advisor checks are all proven
against the CLI's stack; a parallel definition would be a copy that drifts,
and the drift would be discovered as a test passing locally and failing
against the hosted project. `docs/DEPLOYMENT.md` previously recorded this as
a reason to have no Compose file at all, which threw out the app-side
benefit along with the duplication.

## Decision

Compose covers the app and nothing else.

- `Dockerfile` builds the Next.js app as a production image: Bun installs
  dependencies, Node runs `next build`, and the runtime stage carries only
  `.next/standalone` under a non-root user.
- `compose.yaml` defines a single `app` service, joined to
  `supabase_network_t1` as an **external** network. `supabase start` creates
  that network and owns every container on it; `docker compose down` cannot
  take the database with it.
- Inside the network the app reaches the gateway as `http://kong:8000`, set
  in `compose.yaml` rather than in `.env.local`, which is written for host
  processes.
- The stack itself stays with the Supabase CLI. `task dev-up` starts it,
  `task docker-up` starts the app beside it, and neither one defines the
  other's containers.

`Taskfile.yml` is the single command surface for all of this — one runner,
one definition. Task rather than Make because what this project needs from a
runner is exactly what Make has no vocabulary for: descriptions the tool
itself prints (`task`, `task --list`), a prompt before a task that drops the
database, preconditions that say "the stack is not running — `task
dev-start`" instead of surfacing a connection error four layers down,
argument forwarding (`task e2e -- tests/rls.spec.ts`), file-watching
(`task check:watch`), and completion the runner generates for every shell.
Keeping both and having one delegate to the other was tried and discarded:
two files describing one set of commands is a copy that drifts, and the
second front end earned nothing that the first did not already do.

## Consequences

- The production build is exercised on every `task docker-up`, and the
  standalone output is a real artifact rather than a deploy-time hope. It
  caught the first container-specific bug immediately: Bun segfaults running
  `next build` under Alpine, which is why the build stage runs Node.
- `next.config.ts` now sets `output: "standalone"`. It changes what
  `bun run build` emits and nothing about `bun run dev`.
- Task is now a hard prerequisite where Make was already on every machine.
  A real cost, paid knowingly: the alternative was a runner that cannot
  describe its own tasks, cannot ask before dropping a database, and cannot
  state a precondition — which is most of what makes this surface usable by
  someone who has not read the file.
- Two ways to run the app locally means two ways for `.env.local` to be
  wrong. Mitigated by the app service reading the same `.env.local` the host
  process reads, with only `SUPABASE_URL` overridden.
- Compose is a local-development tool here and stays that way. Deployment is
  still Vercel via Pulumi (ADR 0001); this image is not what Vercel runs, and
  the two could drift. Accepted knowingly: the alternative is deploying a
  container to a platform whose free tier is built around the framework's own
  build output.
- `docs/DEPLOYMENT.md`'s "Why no standalone Docker Compose" section is
  replaced by a narrower statement of what Compose does and does not cover.

## Alternatives considered

**A full Compose stack, replacing `supabase start`.** Rejected. It would
duplicate twelve container definitions whose versions currently travel with
the CLI, and the schema is proven by `supabase db reset` against exactly
that stack. Self-hosting Supabase in Compose is a supported path, but it buys
nothing here and would put the tested-and-deployed database configuration a
copy away from the one developers run.

**Compose for the app, on its own bridge network, reaching Postgres through
the published host ports.** Rejected. It works on Docker Desktop through
`host.docker.internal` and breaks on plain Linux, and it routes container
traffic out to the host and back for no gain over joining the network that
already exists.

**No container for the app; keep `bun run dev` as the only local mode.** The
status quo. Rejected because it leaves the production build unexercised
until deploy, which is where the expensive failures live.

**A `dev` target in Compose with the source bind-mounted and hot reload.**
Rejected for now. It would make the container the primary development loop,
which is slower on macOS (bind-mount I/O) than the host process and adds a
layer between an edit and the result. The container's job here is to run
what gets deployed, not to replace the inner loop.
