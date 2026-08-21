# 0010 — Infrastructure as Code

**Status:** proposed · **Lane:** W4-J · **Debt closed:** D-01

## Why

- `infra/` (Pulumi) is claimed working in README, DEPLOYMENT and ADR 0001 while the deploy surface is not declared anywhere (D-01).

## User stories

**US-01** — As a deployer, I want infra/ under Pulumi with Vercel as a native resource and Supabase/Modal command-wrapped, so the whole deployable surface is declared, not remembered.
**US-02** — As CI, I want `pulumi preview`, so infra changes are checked without applying.

## Acceptance criteria (Given / When / Then)

**AC-01** — GIVEN `infra/` in the repo WHEN `pulumi preview` runs THEN it passes in CI (CI job `pulumi-preview`, D-01)
**AC-02** — GIVEN a clean checkout and credentials WHEN `pulumi up` runs from a machine THEN Vercel project (native resource), Supabase `db push` + `functions deploy` (command-wrapped) and the Modal service stand up (D-01)
**AC-03** — GIVEN README.md:130's infra claim WHEN CI runs verify-docs THEN the `<!-- proof: ... -->` marker resolves to `infra/` and a passing preview, or the claim is removed (D-01 via spec 0012 mechanism)
**AC-04** — GIVEN the deploy WHEN it lands THEN ADR 0001's `Status: Accepted` is true or a new revision supersedes it (D-01/D-05 discipline)

## Invariants

- `pulumi preview` is the CI gate; `up` is a machine action, never CI.
- Secrets stay in the platform stores, never in `infra/` code.
- `db push`/`functions deploy` are command-wrapped resources with explicit ordering.

## Out of scope

- Zero-downtime migration orchestration beyond command-wrapped steps.
- Multi-region or autoscaling policy.

## Tasks

See `tasks.md` (P0/P1/P2, lane owner W4-J).
