# 0006: Docker runs the Supabase stack; the app runs on the developer's machine

Status: Accepted

## Context

Four runtimes are involved in developing LedgerLens, and each one is there
for a different reason.

- **Docker** runs the local Supabase stack. `supabase start` brings up
  Postgres, GoTrue, PostgREST, Kong and the Deno Edge Runtime as a dozen
  containers whose image versions are pinned by the Supabase CLI and whose
  configuration travels in `supabase/config.toml`. Migrations, `db reset`,
  the seed and the advisor baseline are all proven against exactly that
  stack.
- **Bun** is the package manager (`bun.lock`), the unit-test runner
  (`bun test`), and what `lint` and `typecheck` invoke.
- **Node** builds and serves the production app. Vercel runs the deployed
  app on Node, and `next build` is a Node toolchain.
- **Deno** exists for `supabase/functions/**` and nothing else. The webhook
  is a Supabase Edge Function, deployed by `supabase functions deploy` onto
  the same open-source `edge-runtime` that `supabase start` runs locally, so
  the local and deployed engines match without any extra effort.

The question this ADR answers is where the *app* runs during development.
Two things need deciding: whether the Next.js dev loop and its checks run in
a container, and whether a container image of the app is worth keeping at
all.

## Decision

**Docker's job is the Supabase stack. Everything else about developing the
app happens on the machine.**

- `task dev` runs `next dev` under Node with the V8 inspector bound to
  `127.0.0.1:9230`. Node rather than Bun for one measured reason: Bun's
  inspector answers `/json/version` but returns an empty `/json/list`, and
  `/json/list` is where IntelliJ IDEA's "Attach to Node.js/Chrome"
  configuration enumerates targets — so it finds nothing to attach to.
  Node's V8 inspector is the protocol that configuration actually speaks.
  `task dev:bun` keeps the Bun dev server for when start-up speed matters
  more than a debugger.
  The IDE attaches to **9231**, not 9230: the flag binds the `next` CLI
  process, and Next forks the server that handles requests onto the next
  free port. Both answer `/json/list`, so attaching to the wrong one
  connects successfully and hits no breakpoint — documented in
  `docs/LOCAL_DEV.md` with the command that tells them apart.
- `task typecheck`, `task lint`, `task test` and therefore `task check` run
  on the machine and require **nothing to be running** — no Docker, no
  Supabase stack. `task check` takes about 14 seconds.
- `task build` runs `node node_modules/next/dist/bin/next build`, guarded by
  a precondition that Node is present and at least major version 22. Bun is
  not used for the build: `next build` under Bun segfaults on Alpine, found
  when the production image was first built, and Node is what both Vercel
  and the runtime image run regardless.
- `task e2e` (Playwright), `task types` and `task types-check` keep needing
  the stack, because they genuinely talk to it. Playwright runs on the
  machine.
- The production image stays, and is **optional**. `Dockerfile` has three
  stages — Bun installs, Node builds, and a traced `.next/standalone` runs
  under a non-root user — and `compose.yaml` defines one service, `app`,
  joined to `supabase_network_t1` as an **external** network so
  `docker compose down` can never take the database with it. `task
  docker-up` is a smoke check: it proves the production build works inside
  Linux, where container-shaped mistakes such as `127.0.0.1` meaning the
  container rather than the host will surface.

**This image is not a stand-in for production.** Vercel builds and serves
the deployed app from Next.js's own output. Running the image proves the
build works in *a* container — a smaller and honestly weaker claim than
parity, and it is the only claim made for it.

There is no dev container, no bind-mounted source, no named `node_modules`
or `.next` volumes, and no containerised checks.

`Taskfile.yml` remains the single command surface. Task rather than Make
because what this project needs is exactly what Make has no vocabulary for:
descriptions the tool prints itself (`task`, `task --list`), a prompt before
anything that drops the database, preconditions that say "the stack is not
running — `task dev-start`" instead of a connection error four layers down,
argument forwarding (`task e2e -- tests/rls.spec.ts`), file watching, and
shell completion it generates itself.

## Consequences

- The inner loop costs nothing it does not have to. `task check` is ~14s and
  needs no stack, so it is cheap enough to run on every save through
  `task check:watch`. A developer can typecheck, lint and unit-test a clone
  with Docker closed.
- **The production build is no longer exercised on every run of the app.**
  It happens when someone runs `task docker-build` or `task docker-up`, and
  nothing forces that. This is the real cost of the decision, and it is
  accepted: a container that is not the deploy target was buying a weaker
  guarantee than its price in daily friction. The guarantee that matters —
  that the build succeeds — belongs in CI, which does not exist yet
  (`PROGRESS.md`).
- **Host and deploy toolchains can diverge.** Bun on macOS is not Bun on
  Linux, and the machine's Node is not Vercel's. `task build` on real Node
  and the optional image are the two places that gap is checkable; neither
  is mandatory. Stated rather than smoothed over.
- CI, when it exists, needs Bun, Node 22 and Deno — not Docker-in-Docker and
  not a running Supabase stack — to run `task check`. That is a materially
  easier CI job than the containerised arrangement would have required.
- Two runtimes now run the dev server (`task dev` on Node, `task dev:bun` on
  Bun), which is one more way for behaviour to differ between developers.
  Bounded deliberately: the Node path is the default and the documented one,
  and Bun's is an explicitly named alternative rather than a silent fallback.
- `next typegen` writes `next-env.d.ts` with a different types path than
  `next dev` does, so the file flips between two committed states depending
  on which ran last. A generated file that dirties `git status` is a
  papercut, not a defect; noted so it is recognised rather than
  investigated twice.
- `next.config.ts` keeps `output: "standalone"`. It shapes what a build
  emits for the image and changes nothing about `next dev`.
- Task is a hard prerequisite where Make would already be on every machine.
  Paid knowingly for the list above.
- The stack still needs Docker, so Docker remains a prerequisite for
  anything that touches the database — `task dev`, `task e2e`,
  `task types-check`, `task verify`. What changed is that the *checks* no
  longer do.

## Alternatives considered

**Containerise the dev loop and every check — the previous version of this
decision.** Rejected after living with it. The argument for it was real:
running checks in the deployed environment catches host/Linux divergence,
and it did catch one thing (the `next build` segfault under Bun on Alpine).
The costs turned out to dominate. Every check required the Supabase stack to
be running, because the `dev` service joined `supabase_network_t1` — a
`typecheck` that touches no database could not run without a database.
`task check` measured ~40s containerised against ~14s on the machine, paid
again on every save under `check:watch`. And the named `node_modules` volume
only populates from the image while empty, so `bun add` on the machine did
not reach the container without a separate volume reset — a failure mode
where every gate passes against a frozen dependency tree. The one bug the
arrangement caught is now covered by `task build` running on real Node.

**A full Compose stack replacing `supabase start`.** Rejected. It would
duplicate a dozen container definitions whose versions travel with the CLI,
and the schema is proven by `supabase db reset` against exactly that stack.
Self-hosting Supabase in Compose is supported, but here it would put the
tested-and-deployed database configuration a copy away from the one
developers run.

**Compose for the app on its own bridge network, reaching Postgres through
the published host ports.** Rejected. It works on Docker Desktop through
`host.docker.internal` and breaks on plain Linux, and it routes container
traffic out to the host and back for no gain over joining the network that
already exists.

**Drop the app image entirely.** Tempting, and nearly right: the image is
not the deploy target, so it cannot prove production works. Kept because it
is nearly free once it is not in the daily path — three Dockerfile stages
and one Compose service — and because the class of bug it catches is one
nothing else here catches, `127.0.0.1` resolving to the wrong host being the
recurring example.

**Run `task dev` on Bun and accept no IDE debugger.** Rejected on evidence
rather than preference: Bun's inspector returns an empty `/json/list`, so
IntelliJ's Node.js attach finds no target. Bun keeps every other role it
had — install, unit tests, lint and typecheck runner — and `task dev:bun`
keeps the faster start-up available by name.

**`supabase functions serve` instead of the stack's bundled `edge_runtime`
container.** Rejected, and recorded because the reasoning is easy to lose:
`serve` does not run inside `supabase start`'s stack at all, so it would be
a second code path relative to what `supabase functions deploy` runs in
production. The bundled container is the same `edge-runtime` engine as the
deployed one, which is parity worth keeping for free.
