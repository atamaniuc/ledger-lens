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

A second gap, found once the production image existed: nothing let IntelliJ
IDEA attach a debugger to code running the way the deployed artifact runs,
and there was no containerised way to run `bun run dev`, `bun test`, or
`tsc` at all — only the host process or the traced production build, nothing
in between. The Edge Functions side already had no such gap: `supabase
start`'s own `edge_runtime` container runs the same open-source
`edge-runtime` that `docs/DEPLOYMENT.md`'s Pulumi program later deploys to
via `supabase functions deploy` on Supabase's hosted platform. `supabase
functions serve` — a separate, lighter CLI-only path — was never adopted
specifically to keep that parity; it doesn't need `supabase start`'s
container at all, and using it would mean the Deno side runs on a different
engine locally than it does in prod.

## Decision

Compose covers the app and nothing else.

- `Dockerfile` builds the Next.js app as a production image: Bun installs
  dependencies, Node runs `next build`, and the runtime stage carries only
  `.next/standalone` under a non-root user.
- `compose.yaml` defines two services, both joined to `supabase_network_t1`
  as an **external** network. `supabase start` creates that network and owns
  every container on it; `docker compose down` cannot take the database with
  it.
  - `app` — the production image, `.next/standalone` traced and copied in at
    build time. What `task docker-up` runs; the pre-deploy exercise of the
    actual artifact, per the rest of this ADR.
  - `dev` — built on the `Dockerfile`'s `deps` stage, no source copied in;
    `compose.yaml` bind-mounts the repository root instead, so an edit is
    live without a rebuild. Two **named** volumes (not anonymous) shadow the
    container's own `node_modules` and `.next`, so the host's (macOS)
    versions never overwrite the Linux-built native deps (`sharp`,
    `unrs-resolver`) the image already installed — named rather than
    anonymous specifically because this service is not only the long-running
    dev server: `task typecheck`/`lint`/`test`/`build`/`start` each run as
    their own one-off `docker compose run --rm dev ...`, and a named volume
    is the same volume across those separate invocations (an anonymous one
    would be recreated, and its contents discarded, on every single run —
    losing `task build`'s `.next` output before `task start` could read it).
    Named over anonymous is a trade, not a strict improvement: a named
    volume is populated from the image only while it's empty, so a rebuilt
    image does **not** refresh an already-populated one — `bun add` on the
    host needs `task dev-volumes-reset` to actually reach the container, not
    just `--build`.
    `compose.yaml` overrides the container's `command:` to `bun
    --inspect=0.0.0.0:9230 node_modules/next/dist/bin/next dev` — **only for
    this service's default (`up`) command**; `package.json`'s own `dev`
    script is `bun --inspect=127.0.0.1:6499 ...` (loopback) — fixed in the
    same pass as this rewrite, from a `NODE_OPTIONS='--inspect' next dev`
    that opened no inspector at all under Bun — so a host `bun run dev`, run
    directly and bypassing Task, never binds a debugger to the LAN. The
    override isn't an env var: Bun ignores `NODE_OPTIONS` (a
    Node convention, not honored for Bun's own inspector), and `BUN_INSPECT`
    gets inherited by both the `bun run` wrapper process and the script it
    spawns, so both try to bind the same port and the second one crashes
    with `EADDRINUSE` — confirmed empirically, not assumed. Running `next` by
    file path under a single `bun --inspect=...` invocation is what actually
    works. Both the app port and the debug port publish loopback-only
    (`127.0.0.1:...`), same reasoning as `app`'s port. What `task dev`
    (foreground) and `task docker-dev` (detached) both run.
- Every `bun run <script>` task in `Taskfile.yml` — `dev`, `build`, `start`,
  `typecheck`, `lint`, `test` — now executes inside the `dev` container
  rather than on the host, for the same reason `docker-up` exercises the
  production image rather than trusting a host build: what runs should be
  what's deployed, not whatever the host toolchain happens to produce. Two
  wrinkles this surfaced, both fixed rather than worked around:
  - `next build` segfaults under Bun on Alpine — the exact crash the
    production `build` Dockerfile stage already avoids by running on
    `node:22-alpine`. The `dev` stage now installs real Node
    (`apk add nodejs`) alongside Bun specifically so `task build` can invoke
    it directly; every other containerised task runs fine under Bun.
  - `tsc --noEmit` depends on ambient types (`LayoutProps`, etc.) that
    Next.js generates into `.next/types/**` as a side effect of `next
    dev`/`next build` having run — since the named `.next` volume can start
    empty (a fresh clone, or after `docker volume rm`), `task typecheck` runs
    `next typegen` (generates just the types, no full build) first rather
    than assuming something else already populated it.
  Deno (`deno-check`) and Playwright (`e2e`) are the two tasks that stay on
  the host: the image has neither Deno nor Playwright's browser binaries,
  and adding either is future scope, not something this change silently
  attempted.
- Inside the network both services reach the gateway as `http://kong:8000`,
  set in `compose.yaml` rather than in `.env.local`, which is written for
  host processes.
- The stack itself stays with the Supabase CLI. `task dev-up` starts it,
  `task dev`/`task docker-up` start the app beside it, and neither Compose
  service defines the stack's own containers.

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
- Every containerised task now needs the local stack running, even ones that
  touch no database — `docker compose run`'s `dev` service joins
  `supabase_network_t1`, which only exists once `supabase start` has created
  it. `task typecheck` used to need nothing; now it needs `task dev-start`
  first. `check:watch` pays a real, measured cost on every save: `task
  check` (typecheck+lint+test, containerised) took ~40s against ~8s for the
  same three run bare on the host — mostly three separate `docker compose
  run` container starts. Accepted knowingly, not smoothed over as "a few
  seconds" — the alternative was "logic" checks that don't actually run in
  the environment being shipped.
- Two ways to run the app locally (`dev`/`docker-dev`, `docker-up`) means two
  ways for `.env.local` to be wrong. Mitigated by both Compose services
  reading the same `.env.local` the host process reads, with only
  `SUPABASE_URL` overridden.
- Compose is a local-development tool here and stays that way. Deployment is
  still Vercel via Pulumi (ADR 0001); this image is not what Vercel runs, and
  the two could drift. Accepted knowingly: the alternative is deploying a
  container to a platform whose free tier is built around the framework's own
  build output.
- `docs/DEPLOYMENT.md`'s "Why no standalone Docker Compose" section is
  replaced by a narrower statement of what Compose does and does not cover.
- Two Dockerfile targets (`dev`, `runner`) and two Compose services are now
  maintained instead of one. A dependency added via a host-side `bun add`
  needs `task dev-volumes-reset`, not just a rebuild — `--build` refreshes
  the *image*, but the named `node_modules` volume, once populated, is not
  re-copied from a rebuilt image. Found by testing the claim rather than
  trusting it: an image rebuilt with a changed dependency, run against the
  same named volume, still served the old one.
- The `dev` service runs as a non-root `bun` user (the `runner` stage's own
  reasoning — this container holds `.env.local`'s service-role key, applies
  here too) but its bind mount is broader than the image's build context:
  `.git`, `supabase/.env`, and gitignored `interview-preps/` are all
  reachable inside it, none of which the image itself ever contains
  (`.dockerignore` excludes all three from the build). Accepted for a
  local-only dev container; would not be accepted for anything that left
  this machine.
- `task check` running in Docker is a future constraint on CI, not just
  local dev: once CI exists (none yet — see `PROGRESS.md`), it will need
  Docker-in-Docker and a running local Supabase stack to run a `typecheck`,
  not just a Bun runtime. Not designed for yet, flagged so it isn't a
  surprise later.
- The Edge Runtime parity with prod (Context, above) was always true; it's
  now written down instead of being an implicit consequence of never having
  adopted `supabase functions serve`.

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
status quo before this ADR's first version. Rejected because it leaves the
production build unexercised until deploy, which is where the expensive
failures live.

**Keep the bind-mounted `dev` target as `docker-up`'s only local companion,
without IDE debug wiring.** Considered when `dev` was added: the container
alone (hot reload, no host toolchain drift) without also solving the
inspector-port problem. Rejected — a dev container you can't attach a
debugger to just trades one gap (no production-build exercise) for another
(no IDE debugging in the environment you're actually testing), and the fix
(a `command:` override, loopback-only publish) was cheap enough — once the
right invocation was found — that skipping it bought nothing.

**`supabase functions serve` instead of `supabase start`'s bundled
`edge_runtime` container.** Considered when writing down the Edge Runtime
parity reasoning (Context, above) — never actually adopted, but worth
recording why. Rejected: it doesn't run inside `supabase start`'s Docker
stack at all, so it's a second, unproven code path relative to what prod
(`supabase functions deploy`, same `edge-runtime` engine) actually runs.

**Containerise only the long-running `dev` server; leave `typecheck`,
`lint`, `test`, `build`, and `start` calling `bun run <script>` on the
host.** The initial shape of this change — revised in the same pass, not as
a later reversal. Rejected: the whole point of the `dev` image is that
Bun-on-Linux is what's deployed, and a host toolchain (Bun-on-macOS here)
can silently diverge from it — which is exactly what the `next build`
segfault surfaced the moment `build` was actually moved into the container;
a host run would never have caught it. The costs are real and stated above
(every containerised task now needs the stack running, `check:watch` is
slower) rather than smoothed over, but they're the same category of cost
`docker-up` already pays for the exact same reason.
