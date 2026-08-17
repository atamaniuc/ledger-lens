# 0001: Infrastructure as Code with Pulumi

Status: Accepted

## Context

The original deployment plan (`docs/DEPLOYMENT.md`) deliberately skipped
Infrastructure as Code: the JD marks it "nice to have," not required, and
each target platform (Vercel, Supabase, Modal) is already driven by its own
CLI + declarative config file, so a Terraform/Pulumi layer on top looked
like boilerplate with no demonstration value for a solo free-tier
deployment.

That reasoning holds for a single, static deployment. It doesn't hold once
the goal shifts to a **repeatable, single-command** deploy — recreating the
whole stack (a second tenant environment, a preview environment, or a
from-scratch redeploy after a mistake) by re-running CLI commands in the
right order, by hand, is exactly the kind of manual multi-step process this
project's own engineering standards argue against elsewhere (idempotent
ingestion, migrations as code, nothing load-bearing left to memory).

Decision changed mid-project: this ADR supersedes the "no IaC" reasoning
previously stated in `docs/DEPLOYMENT.md` and in `.claude/PRD.md`'s
Overview/Stretch non-goals (updated in the same change as this ADR, per
`CLAUDE.md`'s Definition of Done item 7 — not a silent edit).

## Decision

Use **Pulumi** (TypeScript, matching the rest of the stack) as the single
entry point for standing up and tearing down all deployable infrastructure,
in a new `infra/` Pulumi program:

- **Native Pulumi resources** where a stable provider exists:
  - Vercel project, environment variables, and domain — via a Vercel
    provider.
- **Command-wrapped steps** where no native resource provider exists, using
  `@pulumi/command`'s `local.Command` so they still run under `pulumi up`
  rather than as a separate manual step:
  - Supabase: `supabase db push`, `supabase functions deploy
    provider-webhook` (Supabase's own Terraform provider exists but adding
    the Terraform bridge is not worth it for the two operations actually
    needed here).
  - Modal (Stage 7 only): `modal deploy`.
- Pulumi Cloud's free individual tier as the state backend (not a local
  `Pulumi.*.json` file committed to the repo) — avoids ever having
  infra state, which can contain resource IDs and other sensitive output,
  land in git history.
- Stack config (`Pulumi.<stack>.yaml`) is committed; actual secret values go
  through `pulumi config set --secret`, encrypted at rest by the backend,
  never as plaintext in the repo.

## Consequences

- One command (`pulumi up`) stands up or updates the whole deployable
  surface; `pulumi destroy` tears it down cleanly — useful for a second
  tenant environment or recovering from a bad manual change.
- Mixed native/command-wrapped resources means Pulumi's dependency graph
  and drift detection are only fully reliable for the Vercel-managed
  pieces; the command-wrapped steps (Supabase, Modal) are as idempotent as
  the underlying CLI commands are, not independently verified by Pulumi.
  This is a real limitation, not swept under the rug — it will be stated in
  the project README's "What's missing"-style honesty, not presented as
  full IaC coverage.
- Adds a real dependency (Pulumi CLI + a `infra/package.json`) and a small
  amount of ongoing maintenance (provider version bumps) that a purely
  CLI-driven deploy didn't have. Accepted as worth it for repeatability.
- `docs/DEPLOYMENT.md` and `.claude/PRD.md` are updated in the same change
  as this ADR to stop describing IaC as consciously skipped.

## Alternatives considered

- **Stay CLI-driven, no IaC (previous decision).** Simplest, zero extra
  dependency, matches "nice to have" JD framing exactly. Rejected because
  it doesn't hold up once repeatable/multi-environment deploys became a
  goal — see Context.
- **Terraform instead of Pulumi.** Mature Supabase and Vercel providers
  exist for Terraform, arguably better third-party provider coverage than
  Pulumi today. Rejected in favor of Pulumi specifically to keep the
  infra program in TypeScript — one language across app, scripts, and
  infra, rather than introducing HCL as a second config language for a
  solo project.
- **Terraform-bridge Supabase provider inside Pulumi**, instead of
  command-wrapped CLI calls. More "properly" declarative for the Supabase
  pieces. Rejected for now as more setup than the two operations actually
  needed (`db push`, `functions deploy`) justify — revisit if Supabase
  resource management grows beyond that.
