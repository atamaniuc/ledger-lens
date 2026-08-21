# 0015 — Handoff-Driven Development (HDD)

**Status:** in progress · **Lane:** W6 (sequential) · **Debt closed:** D-61 (new)

## Why

- Studied https://github.com/yetanothervan/handoff-driven-development (HDD): specs stay true; **handoffs carry unfinished-work context across sessions** — one file per track, edited in place; an index (TRACKS.md) of live tracks; a protocol to close a track by distillation (outcome → TRACKS-LOG.md, decisions → permanent specs, handoff deleted).
- Our harness had exactly one ad-hoc handoff (docs/HANDOFF.md) with no protocol: no index, no lifecycle (create/update/close), no rule telling an agent to load it, nothing machine-checking it (D-61). The user's resume-in-Claude-Code/Codex mechanism must be formal, not a one-off file.

## User stories

**US-01** — As any agent starting a session, I want an index of live tracks with links to their handoffs, so switching tasks = choosing a handoff.
**US-02** — As an agent ending a session with unfinished work, I want to update the lane's handoff, so the next session picks up exactly where I stopped.
**US-03** — As a maintainer, I want the handoff protocol machine-checked, so a TRACKS.md line pointing at a deleted handoff fails `task check`.
**US-04** — As a human, I want docs to describe the protocol, so a new agent learns it without asking.

## Acceptance criteria (Given / When / Then)

**AC-01** — GIVEN specs/TRACKS.md WHEN read THEN every live-track line links to an existing handoff file (or explicitly to none) and names a lane directory that exists; a broken link fails `task check` (docs-proof checkTracks + test, D-61)
**AC-02** — GIVEN a lane whose tasks are partly done WHEN its session ends THEN the lane dir contains handoff.md (HDD template: context, load-list + anti-list, task, state, decisions, first step) and its TRACKS.md line says active with next:; AGENTS.md instructs to load it (docs-proof audit + AGENTS.md text, D-61)
**AC-03** — GIVEN a closed track WHEN it closes THEN its outcome (1-2 sentences) is in specs/TRACKS-LOG.md (newest first) and its handoff is deleted (checkTracks: no line may link a missing handoff unless marked none; TRACKS-LOG entries exist, D-61)
**AC-04** — GIVEN docs/HARNESS.md and docs/HARNESS-QUICKSTART.md WHEN read THEN they describe the handoff protocol and point to TRACKS.md; markers resolve in task check (proof markers on both, D-61)
**AC-05** — GIVEN docs/HANDOFF.md WHEN the lane lands THEN its content is migrated into specs/0014-dashboard-ux-and-role-model/handoff.md and no reference to docs/HANDOFF.md remains (grep = 0, D-61)

## Invariants

- Handoff state lives only in TRACKS.md + the lane handoff; specs do not duplicate it.
- A handoff is written only when the next session cannot recover context from git/specs in one pass — no handoff noise for finished work.
- Everything machine-checkable stays machine-checked (task check is the gate).

## Out of scope

- Adopting HDD's spec genres (as-built specs describe the existing system): our specs are lane contracts for deliverables and stay that way.
- The specs-audit.py script as-is: our audit is verify-docs.ts, extended with a TRACKS check instead.

## Tasks

See tasks.md (P0 gates the lane; ticked only against the DoD).
