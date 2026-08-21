# Definition of Done — LedgerLens

One Definition of Done for the whole project. Referenced, never copied: a spec
or task list that restates it is wrong. A lane is **done** when all of the
following hold:

1. **Every acceptance criterion in the lane's `spec.md` names an executable
   check** — a test name, an eval case id, or an SQL query — and that check is
   green.
2. **`task check` is green** (typecheck, lint, unit, deno-check) and
   migrations apply clean from an empty database; `get_advisors` shows no new
   warnings against the recorded baseline.
3. **Reviewer pass on the diff**, findings resolved, before the lane is
   handed off.
4. **RLS verified where the diff touches data**: a non-owner `org_id` gets
   empty results, never error-masked data.
5. **No secret and no `service_role` key in the diff** — and none in the
   production client bundle.
6. **Every claim in human docs carries a `<!-- proof: path[:symbol|#test] -->`
   marker** whose target exists; `task check` fails when a marker's target
   does not.
7. **The spec's debt ids are ticked in `DEBT.md`**, each only when its
   closure criterion is machine-verifiable.
8. **`tasks.md` is ticked.** A decision that changed mid-lane gets a new
   decision record (`decisions/NNNN-*.md`) that supersedes the old one
   (`Status: Superseded by NNNN`) — never a silent edit.
