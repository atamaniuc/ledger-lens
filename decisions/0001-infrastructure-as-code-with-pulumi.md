# 0001: Infrastructure as Code with Pulumi

Status: Accepted
Implementation: specs/0010-infrastructure-as-code

## Context

The original deployment plan skipped IaC: the JD marks it "nice to have", and each platform (Vercel, Supabase, Modal) is driven by its own CLI plus config file. That holds for one static deployment, not for a repeatable single-command redeploy (second tenant, preview, recovery from a bad change) — hand-run CLI sequences are the manual multi-step process this project's standards rule out elsewhere.

## Decision

Use **Pulumi** (TypeScript — one language across app, scripts, infra) as the single entry point for the deployable surface, in a new `infra/` program:

- **Native resources** where a stable provider exists: Vercel project, env vars, domain.
- **Command-wrapped steps** via `@pulumi/command` `local.Command` where no native provider earns its keep: Supabase `db push` + `functions deploy` (its Terraform provider exists; the bridge is more setup than two operations justify), Modal `modal deploy` (Stage 7 only).
- **State in Pulumi Cloud's free tier**, never a local `Pulumi.*.json` in git (state can hold resource IDs and secrets). Stack config committed; secrets via `pulumi config set --secret`.

## Consequences

- One `pulumi up` stands up or updates the whole surface; `destroy` tears it down.
- Drift detection is fully reliable only for the Vercel-managed pieces; command-wrapped steps are as idempotent as the underlying CLIs, not independently verified — a real limitation, stated rather than presented as full IaC coverage.
- Adds a real dependency (Pulumi CLI, `infra/package.json`) and provider-version maintenance; accepted for repeatability.
- The deployment documentation was updated in the same change to stop describing IaC as skipped (DoD 7 — not a silent edit). It now lives in `docs/RUNBOOK.md`; `docs/DEPLOYMENT.md` was folded into it when the document set was cut (D-39).

## Alternatives considered

- **Stay CLI-driven, no IaC (previous decision):** simplest, zero dependency. Rejected once repeatable multi-environment deploys became a goal.
- **Terraform instead of Pulumi:** mature providers exist. Rejected to keep infra in TypeScript — no second config language for a solo project.
- **Terraform-bridge Supabase inside Pulumi:** more declarative. Rejected as more setup than `db push` + `functions deploy` justify; revisit if Supabase resource use grows.
