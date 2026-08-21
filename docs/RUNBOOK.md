# LedgerLens — Runbook

What an operator or returning developer needs: prerequisites, the one-command
start, the command surface, how to verify a change, how to deploy, and the
failures this project has actually hit. Claims carry `<!-- proof: ... -->`
markers; the docs gate fails when a target does not exist.

## Prerequisites

| Tool | Why | Check |
|---|---|---|
| [Task](https://taskfile.dev) ≥ 3 | every command below | `task --version` |
| Docker, running | the local Supabase stack | `docker info` |
| Supabase CLI | stack, migrations, functions | `supabase --version` |
| Node ≥ 22 | Next.js, tsx scripts | `node -v` |
| pnpm 10 | install + script runs (packageManager field) | `pnpm -v` |
| Deno | edge-function typecheck — `task check` refuses to pass without it (D-29) | `deno --version` |
| psql | ad-hoc queries | `psql --version` |
| uv | the Python services (`task check-py`, `task index-py`) | `uv --version` |

## From a clean clone

```bash
cp supabase/.env.example supabase/.env   # Edge Functions' shared secrets — read once by supabase start
task up
```

`task up` is one command: `pnpm install` → `supabase start` → `supabase db
reset` (all 22 migrations + a two-tenant seed) → regenerate `.env.local` →
print URLs. App: http://localhost:3000 · Studio: http://127.0.0.1:54323.
Sign in as `alice@acme.test` / `password123` (or `bob@globex.test`).

`task up` deletes `.env.local` first: the env script refuses to overwrite, and
`up` means "recreate everything from the stack". `task reset` is the
standalone destructive database rebuild — it prompts before dropping data.
`task dev` runs the Next.js dev server (Node, hot reload).

## Command surface

| Command | What it does |
|---|---|
| `task up` | clean-clone start: install → stack → reset+seed → env → URLs |
| `task check` | typecheck (next typegen first) · lint · unit · deno-check · docs proofs — needs nothing running |
| `task verify` | stack, then `check` + `types-check` + Playwright e2e + evals — the full gate |
| `task e2e -- <filter>` | Playwright against the running stack (e.g. `task e2e -- tests/rls.spec.ts`) |
| `task evals -- [--verbose \| --allow-skip]` | the CI gate: retrieval recall, abstention, injection safety, citation validity. A skip is red; `--allow-skip` is local-only |
| `task index -- [--org <uuid>]` | rebuild `chunks` from documents + invoices (idempotent) |
| `task index-py -- [--dry-run]` | the same corpus through the Python indexer |
| `task types` / `task types-check` | regenerate `database.types.ts` / fail when it is stale |
| `task psql` / `task logs -- SERVICE=db` | database shell / stack container logs |
| `task docs-check -- --strict docs/ARCHITECTURE.md` | proof markers must resolve |
| `task check-py` / `task check-infra` | Python gate / Pulumi mocked tests (no credentials) |
| `task infra-plan` | the engine plans all 23 resources — local backend, placeholder config, no credentials |
| `task infra-preview` / `task infra-up` / `task infra-destroy` | deployable surface, needs `pulumi login`; `up`/destroy prompt |
| `task docker-build` | build the production image — a smoke check on the production build, not the deployed environment |
| `task clean` | remove build output and test artifacts |

## Verifying a change

1. `task check` — pure logic, nothing running. Green before anything else.
2. `task types-check` — schema and generated types agree.
3. `task verify` — the live stack: migrations apply from empty, the e2e
   suite (RLS proofs, ingestion, agent safety) and `task evals` against the
   fixed thresholds.
4. Docs: every changed claim carries a proof marker; `task docs-check`
   (inside `task check`) fails when a target disappears.

### What CI runs, and why there are two badges

**`ci.yml`** — six jobs, all green, all running the same commands as above:
`check`, `e2e`, `python`, `infra`, `gitleaks`, `knip`. This workflow answers
"is the code correct". <!-- proof: .github/workflows/ci.yml -->

**`evals.yml`** — the measurement gate, red on purpose. With no model key in the
repository the three model-dependent metrics report *not measured* and the run
exits non-zero (D-24 — a measurement that did not happen is not a measurement
that passed). The deterministic half runs there on every push and passes:
recall@5 1.00 (28/28), abstention 1.00 (15/15).
<!-- proof: .github/workflows/evals.yml -->

They are separate files because a single red badge meaning "no key configured"
gets read as "broken build", and that is its own kind of false claim.

**What a push costs.** Both workflows run a `changes` job first that diffs the
actual commit (full history, not shallow — a shallow clone makes `HEAD~1`
invisible and the heavy jobs then run or skip for the wrong reason). If only
`docs/`, `README.md`, `DEBT.md`, `specs/` or `decisions/` moved, `e2e`, `python`
and `evals` are skipped and the push pays for the fast check jobs only. Any
code, test, migration, seed, Taskfile or workflow change runs the heavy jobs —
and if the diff cannot be computed, they run anyway (failing open costs a job;
failing closed costs the truth).

Two ways to change that, and both are a human's call. Add
`secrets.GROQ_API_KEY` and accept that one push spends a free tier's entire
daily token budget (a full run is ≈185k of 200k), or leave it red and measure
deliberately with `task evals` on a machine that holds a key. What is not on
the table is passing `--allow-skip` in CI, which would turn the gate back into
decoration.

Route-level assertions that need a model — the 429/402 refusals, streaming,
cancellation — skip in CI with that sentence and say so in the output. The
mechanisms behind them are asserted without a model: the budget verdicts
directly against `check_agent_budget`, the loop against a stubbed client.
<!-- proof: tests/agent-rate-limit.spec.ts#over the per-user limit the same RPC refuses (SQL, no model needed) -->

## Deploying (human steps)

Before owning anything: `task infra-plan` runs the real Pulumi engine against a
throwaway local backend with placeholder config and plans all 23 resources, so
the program is verified end to end before a single credential exists.
<!-- proof: task infra-plan --> <!-- proof: infra/scripts/plan.sh -->

Prereqs: `pulumi login` (Pulumi Cloud, free tier) and `supabase login`;
a hosted Supabase project. One-time from `infra/`: `pulumi config set`
the secrets named in `infra/README.md` (anon key plaintext, the rest
`--secret`).

Recommended: `task infra-up` — one `pulumi up -s prod` that creates the
Vercel project + env vars natively, then command-wrapped `supabase db push`
and `supabase functions deploy provider-webhook embed` (each re-runs only
when its trigger files change). Review `task infra-preview` first;
`task infra-destroy` tears it down. CI never runs `pulumi up` — deploys
are a machine action.

**Status of this project's hosted half (as of 2026-08-21):** the schema is
fully pushed (22 of 22 migrations, verified with `supabase migration list`)
and all three Edge Functions are deployed and answering — unsigned calls get
401, a signed embed call returned a real 384-dimension vector. What is NOT
provisioned is the hosted data: migrations carry no tenants, no users and no
corpus, because the seed is a local-stack step by design. After the app is up,
run `scripts/provision-hosted.sh` with the hosted project's URL and
service-role key (from the Supabase dashboard) to create the two tenants and
the two sign-in users; it is idempotent. Invoices and the corpus then come
from an ingestion pass against the deployed app.
<!-- proof: scripts/provision-hosted.sh -->

By hand, the same steps: `supabase link --project-ref <ref>` →
`supabase db push` → `supabase functions deploy provider-webhook embed`.
For transcription (py/modal): `supabase functions deploy transcribe-webhook`
plus `modal deploy` from `py/modal` after creating the Modal secret —
see `py/modal/README.md`.

## Copilot runtime knobs (admin panel)

`/admin` (sign in as an org admin) edits three things without a redeploy:

- **Guards** — off means the copilot never returns 429/402; for presentations
  and stress tests. Default on.
- **Demo mode** — on means the copilot ALWAYS answers, deterministically from
  this tenant's real data with no model call, even when every provider is
  spent or unconfigured. Answers are marked "Demo answer". The thing to turn
  on before a presentation.

### How the demo answers work (no model involved)

The demo path is not a stub with canned text — it is a scripted answer over
REAL data, through the SAME tools the agent would use:

1. **Intent by pattern, not by LLM.** The route matches the question against
   three shapes: totals/counts (`revenue|total|how much|average`), open
   invoices (`overdue|open|unpaid`), and corpus questions
   (`payment term|policy`). Anything else gets a polite answer listing the
   shapes it understands.
2. **A real tool runs.** `get_revenue_summary`, `list_invoices` or
   `search_documents` — the exact functions the agent would call — execute
   under the caller's JWT, so RLS decides which rows come back. No
   cross-tenant data can leak, because the read path is identical to the
   agent's.
3. **The answer is assembled by template from real values**, with real
   citation ids from the tool result: `Demo answer: total invoiced value is
   USD 52,417 across 180 invoices. Largest: [inv-2] [inv-1]`.
4. **Zero tokens, zero providers, zero limits.** The model is never called,
   so a spent budget, a rate limit or a missing key cannot produce an error.
   A presentation cannot fail on the copilot.
5. **It is marked.** Every demo answer carries `demo: true` and the panel
   shows a "Demo answer" badge, so it is never mistaken for a model answer.
   The code lives in `src/features/agent/demo-answer.ts`; the e2e proof is
   `tests/copilot-demo-mode.spec.ts` (no provider, spent budget → 200).

Safety is unchanged: the tools still run under the user's JWT, RLS still
scopes every row, and the registry still bounds what can happen. Demo mode
only changes WHO composes the answer — a template instead of a model.
- **Runtime providers** — OpenAI-compatible endpoints added at runtime; the
  API key is read from the named environment variable at call time and never
  stored. They join the failover chain after the environment-configured ones.

The settings live in `copilot_settings` (a singleton, RLS-protected, written
only through SECURITY DEFINER functions that check the admin role).

## Troubleshooting — failures actually hit in this project

## Troubleshooting — failures actually hit in this project

- **`supabase status` dies on its own telemetry write (D-46).** The CLI can
  fail writing `~/.supabase/telemetry.json.tmp` while all containers are
  healthy, taking the suite down with it. Fixes, all in tree: tests read
  `.env.local` first and fall back to the CLI only with `DO_NOT_TRACK=1`;
  the Taskfile sets `DO_NOT_TRACK=1` globally; `task stack-running` probes
  the container and the REST endpoint instead of trusting the CLI exit code.
- **Edge Runtime kills the embed worker with HTTP 546 (D-47).** A batch of 16
  texts exceeds the per-request CPU budget and dies with no partial result.
  The client sends at most 8 texts per request, retries 4× with jittered
  backoff, and on 546 splits the batch in half down to single texts. A 546 is
  a smaller-batch question, not a retry-forever one.
- **`[auth.email].enable_signup = false` locks every user out (D-20).** That
  flag maps to GoTrue's `EXTERNAL_EMAIL_ENABLED` and refuses existing users
  with `email_provider_disabled`. Registration is closed by the project-level
  `[auth] enable_signup = false`; `[auth.email]` must stay `true`.
- **`.env.local` is not auto-loaded by Node (D-48).** Bun loaded it itself;
  Node does not, so script entrypoints pass
  `--env-file-if-exists=.env.local` (`task evals`, `task index`).
  `EmbeddingError: SUPABASE_URL is not set` with the stack up is this.
- **A shared `src/` module may not import through `@/` (D-49).** The Edge
  Functions import `src/features/ingestion/transform.ts` and
  `src/platform/hash.ts` directly, and Deno has no TypeScript path aliases: an
  alias inside a shared file type-checks clean, passes `deno check`, and then
  every webhook returns 503 with `worker boot error: Relative import path
  "@/platform/hash" not prefixed with / or ./ or ../`. Import relatively, or
  keep the module import-free. The e2e suite is what catches this — it boots
  every function. <!-- proof: src/platform/hash.ts:hashPayload -->
- **Never `docker restart` a Supabase container.** The edge runtime comes back
  `Exited (127)` because the CLI starts it with a bespoke command that a plain
  restart does not reproduce. After editing a file a function imports, run
  `supabase stop && supabase start` — the compile cache under
  `/var/tmp/sb-compile-edge-runtime` also survives a hot reload of files outside
  `supabase/functions/`.
- **Debugger ports.** `task dev` binds the `next` CLI to `DEBUG_PORT`
  (default 9230); the forked server takes the next free port (9231). Route
  handlers and Server Components live in the child — attach to 9231.
- **`next typegen` before `tsc`.** A fresh clone has no `.next/types/**`;
  `task typecheck` runs `next typegen` first so `tsc --noEmit` can see the
  route/layout ambient types.

## Deliberately not here

Per-stage walkthroughs, curl recipes, IDE setup and the full env table were
cut with `docs/LOCAL_DEV.md` (D-39). The typed env schema is
`src/platform/config.ts`; the template with every variable is
`.env.example`.

<!-- proof: task up --> <!-- proof: task check --> <!-- proof: task verify --> <!-- proof: task e2e --> <!-- proof: task evals -->
<!-- proof: task index --> <!-- proof: task index-py --> <!-- proof: task types --> <!-- proof: task types-check --> <!-- proof: task psql -->
<!-- proof: task logs --> <!-- proof: task docs-check --> <!-- proof: task check-py --> <!-- proof: task check-infra --> <!-- proof: task infra-preview -->
<!-- proof: task infra-up --> <!-- proof: task infra-destroy --> <!-- proof: task reset --> <!-- proof: task dev --> <!-- proof: task clean -->
<!-- proof: supabase/seed.sql --> <!-- proof: scripts/write-env-local.sh --> <!-- proof: supabase/.env.example --> <!-- proof: infra/README.md --> <!-- proof: py/modal/README.md -->
<!-- proof: supabase/config.toml:enable_signup --> <!-- proof: tests/helpers/stack.ts --> <!-- proof: src/features/rag/embed.ts:WORKER_LIMIT_STATUS --> <!-- proof: src/features/rag/embed.ts:EMBED_BATCH_LIMIT --> <!-- proof: src/features/rag/embed.ts:MAX_ATTEMPTS -->
<!-- proof: src/platform/config.ts:envSchema --> <!-- proof: .env.example --> <!-- proof: evals/thresholds.json -->
# test
# diff-gate probe 2
