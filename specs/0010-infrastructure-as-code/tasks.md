# 0010 — Tasks

Lane owner: **W4-J**. Debt: D-01. P0 gates the lane; P1/P2 follow. A batch is one commit; every commit's message carries the D-XX or spec id. Ticked only against the DoD (`specs/DoD.md`).

## P0

- [x] **T1** `infra/` scaffold: Pulumi program, Vercel native resource (D-01)
- [x] **T2** Supabase `db push` + `functions deploy` as command-wrapped resources (D-01)
- [ ] **T3** Modal service as command-wrapped resource (with spec 0009)
- [x] **T4** CI job `pulumi-preview` (D-01)
- [x] **T5** README/DEPLOYMENT/ADR 0001 reconciled with reality via proof markers (D-01, with spec 0012)

## P1

- [ ] **T6** Stack split: dev vs prod stacks with distinct env
- [ ] **T7** Drift detection in CI (preview against the recorded stack)

## P2

- [ ] **T8** Teardown script for the demo environment

