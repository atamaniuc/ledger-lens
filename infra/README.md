# infra/ — LedgerLens deployable infrastructure (spec 0010, D-01)

One `pulumi up` stands up the whole deployable surface — the claim README.md
and docs/RUNBOOK.md already make. Vercel is native; Supabase is
command-wrapped; Modal is a disabled stub (not built, spec 0009).
## Two honest tiers

- **Native** (`vercel.ts`): `vercel.Project`, one
  `vercel.ProjectEnvironmentVariable` per catalog entry, and a
  `vercel.ProjectDomain` when config `domain` is set. Real drift detection.
- **Command-wrapped** (`supabase.ts`): `local.Command` steps — `supabase db
  push`, `supabase secrets set`, `functions deploy provider-webhook` and
  `embed`. Each carries a sha256 trigger derived from the exact files it
  depends on (a changed migration/function re-runs it) and explicit
  `dependsOn`: schema → secrets → functions. Only as idempotent as the
  underlying CLIs — stated, not hidden.
- **Modal** (`modal.ts`): TODO(spec 0009) — disabled, registers nothing.
Every Vercel env var comes from one typed catalog (`env.ts`), cross-checked
against `.env.example`; a missing required variable fails `pulumi up` and
names the fix. Secrets are Pulumi secrets + Vercel "sensitive"; the
service-role key is asserted never to be a `NEXT_PUBLIC_*` var. `APP_ENV=
production` and every `CHAOS_*` flag are `false` explicitly (D-16).
## Gate — no cloud credentials needed
```bash
task check-infra   # typecheck + 29 unit tests with pulumi.runtime.setMocks
task infra-plan    # the real engine plans all 23 resources, still no credentials
```
The mocked tests prove the shape of what the program builds. `task infra-plan`
proves what mocks cannot: that the engine loads the program, resolves both
providers, computes every output and plans every resource — against a throwaway
file backend with placeholder config (`infra/scripts/plan.sh`). Nothing is
created and nothing reaches Vercel; a preview of creates makes no API call. The
one value that must look real is the Vercel token, because the provider
validates its shape (24 lowercase hex characters) before anything else.

Against the real stack, `pulumi preview` needs a backend: without login it fails
with `error: PULUMI_ACCESS_TOKEN must be set for login during non-interactive CLI
sessions`. The one command a human runs: `pulumi login` (Pulumi Cloud free tier).
## One-time setup (from `infra/`)
```bash
pulumi login                              # Pulumi Cloud, free tier
pulumi config set supabaseAnonKey <anon>  # public anon key
pulumi config set --secret vercelApiToken <token>
pulumi config set --secret supabaseAccessToken <token>
pulumi config set --secret dbPassword <password>
pulumi config set --secret supabaseServiceRoleKey <key>
pulumi config set --secret ingestionTriggerSecret <secret>
pulumi config set --secret webhookSharedSecret <secret>
pulumi config set --secret embedSharedSecret <secret>
# optional: llm keys, llmProvider, models, vercelTeamId, domain
```
`Pulumi.prod.yaml` holds public values only — no secrets are ever committed.
## Deploy
Prereqs: pulumi + supabase CLIs, Node 22+/pnpm, hosted Supabase. CI runs the
gate above; `up` is a machine action, never CI (spec 0010).

```bash
cd infra
pulumi preview -s prod   # review the diff
pulumi up -s prod        # project + env vars + domain, db push, functions
pulumi destroy -s prod   # tear it all down
```

Files: `index.ts` entry · `program.ts` wiring · `config.ts` config ·
`env.ts` catalog · `vercel.ts` native · `supabase.ts` commands ·
`modal.ts` stub · `triggers.ts` triggers · `__tests__/` the gate.
