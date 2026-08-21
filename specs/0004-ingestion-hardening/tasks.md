# 0004 — Tasks

Lane owner: **W2-E**. Debt: D-15, D-16, D-17, D-19. P0 gates the lane; P1/P2 follow. A batch is one commit; every commit's message carries the D-XX or spec id. Ticked only against the DoD (`specs/DoD.md`).

## P0

- [x] **T1** HMAC + timestamp + nonce on `provider-webhook` and the embed function; timing-safe compare; replay rejection (D-19)
- [x] **T2** Replay test: identical signed request delivered twice (D-19)
- [x] **T3** `futureDates` rule in transform → quarantine + test (D-15)
- [x] **T4** Chaos OFF unless `APP_ENV=dev|test`; prod-config test (D-16)
- [x] **T5** Ingest budget from env (`INGEST_BUDGET_MS`), platform value documented (D-17)

## P1

- [x] **T6** Embed function gets the same HMAC scheme if it still shares the webhook secret
- [x] **T7** Body-size limit on webhook + embed routes

## P2

- [ ] **T8** Chaos-mode regression matrix: every flag fires, survives, and is logged (extends the existing 7-flag suite)

