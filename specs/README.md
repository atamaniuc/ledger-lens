# Specs — how this SDD works

Spec-driven development, OpenSpec-shaped, no tooling beyond Markdown. Four rules:

1. **One spec = one lane = one deliverable.** Work never starts without reading
   `specs/NNNN-<slug>/spec.md`; the lane's scope is that file.
2. **Acceptance criteria are executable.** Every criterion names a test, an eval
   case id, or an SQL query. A criterion that cannot run does not exist.
3. **DoD is one file, referenced never copied** — `specs/DoD.md`.
4. **The register is the truth.** A debt item is ticked in `DEBT.md` only when
   its closure criterion is machine-verifiable; a commit message carries the
   `D-XX` id or spec id it closes.

Layout:

| file | role |
|---|---|
| `product.md` | the product: one screen, problem, users, killer features, non-goals |
| `DoD.md` | the single Definition of Done for the whole project |
| `NNNN-<slug>/spec.md` | lane contract: status, stories, Given/When/Then criteria, invariants, out of scope, debt closed |
| `NNNN-<slug>/tasks.md` | lane checklist: P0/P1/P2, sub-tasks, lane owner, `D-XX` links |
| `archive/` | condensed record of what already shipped (stages 1–6) |

Status flow: `proposed` → `in-progress` (lane starts) → `done` (DoD met) → moved to `archive/`.
