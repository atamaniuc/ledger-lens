# 0003 — Tasks

Lane owner: **W2-B**. Debt: D-11, D-12, D-13, D-14, D-10. P0 gates the lane; P1/P2 follow. A batch is one commit; every commit's message carries the D-XX or spec id. Ticked only against the DoD (`specs/DoD.md`).

## P0

- [x] **T1** Migration `20260821110000_scheduler_locks_and_cron.sql`: pg_cron extension, 3 jobs (ingest, quality, reindex), advisory-lock function, partial unique index on one `running` per org (D-11, D-12)
- [x] **T2** `pg_try_advisory_lock` around cursor advance in the run path (D-12)
- [x] **T3** Reap from both polling and webhook completion paths (D-13)
- [x] **T4** Reindex on schedule/event; freshness test (D-14)
- [x] **T5** Remove/replace the “Stage 4's cron” comment (D-10)

## P1

- [ ] **T6** Scheduler overrides: skip-next, run-now for a single job
- [x] **T7** E2E “ran without a human”: a full ingest→quality→reindex cycle from cron with zero manual triggers (D-11 closure)

## P2

- [ ] **T8** Dead-lettering of failed scheduled runs into quarantine-adjacent reporting

