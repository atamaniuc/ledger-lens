# LedgerLens — Deployment

Free-tier deployment plan for LedgerLens. Self-contained: everything needed
to take this from local to running is here or in this repo — no dependency
on untracked notes.

## Infrastructure as Code: Pulumi

All deployable infrastructure is stood up through a single Pulumi program
in `infra/` (TypeScript, matching the rest of the stack) — one command
(`pulumi up`) rather than a hand-ordered sequence of CLI calls across three
platforms. See [ADR 0001](../.claude/adr/0001-infrastructure-as-code-with-pulumi.md)
for the full reasoning and what changed from the earlier "no IaC" decision.

Two kinds of resources live in `infra/`, and the distinction matters —
stated plainly rather than presented as uniform IaC coverage:

- **Native Pulumi resources** (real dependency graph, drift detection):
  Vercel project, its environment variables, its domain.
- **Command-wrapped steps** (`@pulumi/command`'s `local.Command`, still
  orchestrated by `pulumi up`, but only as idempotent as the underlying
  CLI): `supabase db push`, `supabase functions deploy provider-webhook`,
  and (Stage 7 only) `modal deploy`. No stable native Pulumi provider covers
  these two operations well enough to justify the setup cost yet.

State backend: Pulumi Cloud's free individual tier — not a local state
file committed to the repo. Stack config (`Pulumi.<stack>.yaml`) is
committed; actual secrets go through `pulumi config set --secret`
(encrypted at rest), never as plaintext in the repo.

## What Docker Compose does and does not cover

`compose.yaml` covers the Next.js app only, in two modes, both joined to the
network `supabase start` already created: a production image (`task
docker-up`), so the deployed artifact gets exercised locally instead of
first on the deploy target, and a bind-mounted dev image with hot reload and
an IDE-attachable debugger (`task docker-dev`), for catching container-
specific bugs without giving up the inner loop. See
[ADR 0006](../.claude/adr/0006-the-app-is-containerised-the-supabase-stack-is-not-duplicated.md).

It deliberately does **not** define Postgres, Auth, PostgREST or the Edge
Runtime. `supabase start` owns those containers, their versions travel with
`supabase/config.toml`, and the schema is proven against exactly that stack
by `supabase db reset`; a second definition would be a copy that drifts.
Full reasoning in [ADR 0006](../.claude/adr/0006-the-app-is-containerised-the-supabase-stack-is-not-duplicated.md).

Compose is a local-development tool here and stays one — Vercel builds and
runs the deployed app, not this image. Unrelated to the Pulumi decision
above, which is for the deployed infrastructure.

## Target platforms (all free tier)

| Component | Platform | Managed by |
|---|---|---|
| Next.js app | Vercel | Pulumi (native resource) |
| Postgres, pgvector, Auth, Realtime | Supabase | Pulumi (command-wrapped `db push`) |
| Webhook receiver (Deno) | Supabase Edge Functions | Pulumi (command-wrapped `functions deploy`) |
| Whisper transcription (Stage 7, optional) | Modal | Pulumi (command-wrapped `modal deploy`) |
| CI / evals gate | GitHub Actions | Not Pulumi-managed — a workflow file, not deployable infra |

## One-time setup

```bash
# Next.js app (once Phase 1 design for project layout is decided —
# see .claude/DESIGN.md)
bunx create-next-app@latest ledgerlens --typescript --tailwind --app
cd ledgerlens
bun add @supabase/supabase-js zod @tanstack/react-query
bun add @anthropic-ai/sdk        # or openai

# Supabase — local dev
bunx supabase init
bunx supabase start                          # local Postgres w/ pgvector
bunx supabase login
bunx supabase link --project-ref <ref>       # from supabase.com dashboard

# Deno Edge Function for the ingestion webhook (see docs/DATABASE_SCHEMA.md
# and the Ingestion & Transform PRD entry)
bunx supabase functions new provider-webhook

# Pulumi — infra program
mkdir infra && cd infra
pulumi login                                 # Pulumi Cloud, free tier
pulumi new typescript                        # or hand-write Pulumi.yaml + index.ts
bun add @pulumi/pulumi @pulumi/command
bun add @pulumiverse/vercel                  # Vercel provider
pulumi config set --secret vercelApiToken <token>
pulumi config set --secret supabaseAccessToken <token>
```

Python (embeddings + evals, per the RAG & Agent / Evals PRD entries):

```bash
pip install openai pydantic psycopg[binary] python-dotenv --break-system-packages
```

Modal (optional, Stage 7 only):

```bash
pip install modal --break-system-packages
modal setup
```

## Environment variables

None of these exist yet (no app scaffolded) — this is the checklist for
when Phase 2 execution begins. **Never commit any of these** — local dev
uses `.env.local` (already gitignored); deployed values are set as Vercel
env vars *through the Pulumi program* (`vercel.EnvironmentVariable`
resources), not clicked in by hand, so they're reproducible and diffable
via `pulumi preview`.

| Variable | Set via | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Pulumi → Vercel env var, `.env.local` locally | Public — safe client-side |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Pulumi → Vercel env var, `.env.local` locally | Public — RLS is the actual boundary, not this key |
| `SUPABASE_SERVICE_ROLE_KEY` | Pulumi → Vercel env var, marked sensitive | **Never** in client code — CLAUDE.md hard rule |
| `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`) | Pulumi → Vercel env var, marked sensitive | LLM calls happen server-side / in the agent, never from the browser |
| `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` | Local + CI only (Stage 7) | Not needed by the deployed Next.js app itself |

## Deploy sequence

```bash
cd infra
pulumi preview     # review the diff before touching anything
pulumi up          # provisions/updates Vercel project + env vars,
                    # runs supabase db push, runs functions deploy
```

Equivalent tasks to be added to `Taskfile.yml` alongside the `infra/` program
(`task infra-preview`, `task infra-up`, `task infra-destroy`) — not added
yet because there is no `infra/` program for them to call; adding
non-functional tasks ahead of the code they drive would just be dead
config. Wire them in during the Stage 1/2 implementation pass, same as the
app-level targets.

## CI

GitHub Actions runs `task evals` (once it exists) on every PR — see the
Evals PRD entry in `.claude/PRD.md` for the thresholds that gate the merge.
Same command locally and in CI, so there's no drift between "passes on my
machine" and "passes in CI." CI does not run `pulumi up` — infra changes
deploy from a developer machine (or a separate, explicitly-triggered deploy
job) after `pulumi preview` has been reviewed, not automatically on every
merge.

## Readiness checklist

Before pushing/deploying at any point in this project's life:

- [ ] `git status` clean or intentionally staged — no secrets in the diff (`.env*`, `settings.local.json`, and Pulumi passphrase/access token stay gitignored or out of the repo entirely)
- [ ] `.gitignore` still excludes `interview-preps/`, `.worktrees/`, `node_modules/`, `.next/`, `.env*`
- [ ] Committed docs (`docs/`, `.claude/PRD.md`, `README*.md`) are self-contained — no load-bearing link into the gitignored `interview-preps/` zone
- [ ] `pulumi preview` reviewed before `pulumi up` — no un-reviewed infra diff ever applied blind
- [ ] `task codex-review` (or `code-reviewer`) has run clean on the diff being pushed, per the Delegation Ladder in `CLAUDE.md`
- [ ] RLS verified per Definition of Done item 4 before any migration touching a new table ships
