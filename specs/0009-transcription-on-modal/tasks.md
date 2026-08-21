# 0009 — Tasks

Lane owner: **W3-H**. Debt: D-42. P0 gates the lane; P1/P2 follow. A batch is one commit; every commit's message carries the D-XX or spec id. Ticked only against the DoD (`specs/DoD.md`).

## P0

- [ ] **T1** `py/modal/`: Modal Whisper function, audio → timestamped transcript (D-42)
- [ ] **T2** Signed webhook from Modal into `raw_events` with the shared ingest contract (D-42)
- [ ] **T3** Idempotency test: same audio twice → no duplicate rows (D-42)
- [ ] **T4** Malformed/impossible transcript → quarantine + reason (D-42)

## P1

- [ ] **T5** Chunk the transcript like a document source (`source_kind` extension)
- [ ] **T6** Size/time limits on uploaded audio; env-configured

## P2

- [ ] **T7** Cost accounting for Modal minutes into `llm_calls`-adjacent rows (with spec 0011)

