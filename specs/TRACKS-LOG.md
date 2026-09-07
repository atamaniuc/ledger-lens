# Work tracks — archive

Closed tracks, newest first. Handoffs are deleted on close; details live in git history and the lanes' specs. Format: closing date — essence — outcome in 1–2 sentences.

- **Harnessimo adoption (spec 0018)** — the proof-marker, work-track and task gates now
  delegate to a shared package instead of being implemented here, and the repository gained
  locked surfaces, a clean-state check and a cold-start test it never had. The 38 existing
  unit tests passed unchanged, which is what made the switch a delegation rather than a
  rewrite.
- **Gated task state & clean exit (spec 0017)** — a checked box in a live lane must name a
  check that resolves (T1/T2), and the two remaining tasks closed through Harnessimo rather
  than local scripts: clean exit and the cold-start test are commands with exit codes now,
  not checklists.
- **2026-08-21 — 0015 Handoff-driven development** — HDD adopted into the harness: specs/TRACKS.md index + TRACKS-LOG.md archive, per-lane handoffs in the HDD template, AGENTS.md/HARNESS rules, and a machine audit (checkTracks) that fails `task check` on a dead track link or missing status; D-61 registered.
- **2026-08-21 — 0014 Dashboard UX, role model, ops docs** — signed-in shell (AppHeader/LogoutButton), invoice search+status filters with Clear, 3-role seeds (alice admin / bob member / carol viewer), ACCOUNTS/C4/PATTERNS/QA-MANUAL docs, role-aware Admin link, viewer e2e; D-56..D-60 registered; deploy stays a separate blocked track.
- Lanes 0001–0013 closed under the pre-HDD flow (no handoffs): their outcome is the squashed refactor baseline (tag refactor-baseline-main).

