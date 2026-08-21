# 0006: Docker runs the Supabase stack; the app runs on the developer's machine

Status: Accepted

## Context

Four runtimes, each for a different reason. **Docker** runs the local Supabase stack (`supabase start`: Postgres, GoTrue, PostgREST, Kong, edge-runtime; versions pinned by the CLI). **Bun** is the package manager, unit-test runner, and what lint/typecheck invoke. **Node** builds and serves production (Vercel runs Node). **Deno** exists for `supabase/functions/**` only; deployed functions run on the same open-source `edge-runtime` `supabase start` runs locally. The question: where does the *app* run during development, and is a container image of it worth keeping?

## Decision

**Docker's job is the Supabase stack. Everything else happens on the machine.**

- `task dev` runs `next dev` under Node with the V8 inspector on `127.0.0.1:9230`; the IDE attaches to **9231** because Next forks the serving server onto the next free port (documented in `docs/RUNBOOK.md`). Measured reason for Node: Bun's inspector answers `/json/version` but returns an empty `/json/list` — the endpoint IntelliJ enumerates — so there is no attach target. Bun has since been removed from the project altogether (D-38): it was doing dependency install and unit tests only, its `next build` segfaulted on Alpine, and this inspector gap is why the dev server was never on it.
- `task check` (~14 s) runs with nothing running — no Docker, no stack.
- `task build` uses Node ≥22, not Bun: `next build` under Bun segfaults on Alpine (found on the first image build).
- The production image stays, **optional**: three-stage Dockerfile (Bun install → Node build → non-root `.next/standalone`), one Compose service on the **external** `supabase_network_t1` so `docker compose down` can never take the database. `task docker-up` is a smoke check that the build works in *a* container — an honestly weaker claim than parity, the only claim made. No dev container, no bind mounts, no containerised checks.
- `Taskfile.yml` is the single command surface. Task, not Make: self-printed descriptions, preconditions, argument forwarding, file watching, shell completion.

## Consequences

- `task check` is ~14 s and stack-free — cheap enough for `task check:watch` on every save.
- The production build is no longer exercised on every run — the real cost, accepted: a container that is not the deploy target was buying a weaker guarantee than its daily friction. Build success belongs in CI, which does not exist yet.
- Host and deploy toolchains can diverge (macOS Bun vs Linux, machine Node vs Vercel's); checkable only where noted.
- CI needs Bun, Node 22, Deno — no Docker-in-Docker, no running Supabase stack.
- Two dev-server runtimes exist (Node default, Bun named alternative) — one more divergence surface, bounded deliberately.
- `next typegen` flips `next-env.d.ts` between two committed states — a papercut, recognised.

## Alternatives considered

- **Containerise the dev loop and every check (previous version):** rejected after living with it — every check needed the stack running (a no-DB typecheck could not run), `task check` was ~40 s vs ~14 s, and the named `node_modules` volume only populated from the image while empty — gates passed against a frozen dependency tree. The one bug it caught (Bun/Alpine segfault) is now covered by `task build` on real Node.
- **Full Compose stack replacing `supabase start`:** duplicates a dozen container definitions whose versions travel with the CLI; the schema is proven by `db reset` against exactly that stack.
- **Compose on a bridge network via published host ports:** works on Docker Desktop (`host.docker.internal`), breaks on plain Linux.
- **Drop the app image entirely:** nearly right — it is not the deploy target. Kept because it is nearly free off the daily path and catches a bug class nothing else catches (`127.0.0.1` meaning the container).
- **`task dev` on Bun, accept no IDE debugger:** rejected on evidence — empty `/json/list`, no attach target.
- **`supabase functions serve` instead of the bundled `edge_runtime` container:** a second code path relative to production; the bundled container is the same engine as deployed — parity kept for free.
