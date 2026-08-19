# Stage 6 — Evals + CI gate

**Status: done, built as a proof of concept.** Stage 5's list is archived at
[`.claude/tasks/stage-5-rag-agent.md`](.claude/tasks/stage-5-rag-agent.md).

No batch checklist for this one, deliberately. The PRD entry already carried
four testable P0 stories and the work was one sitting — a checklist restating
them would have been the plan written twice, which `CLAUDE.md` names as the
thing to avoid.

## What shipped

- `evals/dataset.jsonl` — 20 cases: 8 `retrieval`, 5 `unanswerable`,
  2 `injection`, 3 `metric`, 2 `lookup`, split across both tenants so a case
  written for Acme cannot score against Globex's corpus.
- `evals/thresholds.json` — versioned (`2026-08-19.1`), so a threshold change
  is a visible diff rather than a number someone edited in a script.
- `evals/run.ts` — imports `lib/rag` and `lib/agent` and calls them the way the
  app does. Two tiers: deterministic metrics always run; model-dependent ones
  report `skip` without an API key rather than scoring 0/0 as a pass.
- `task evals` and `.github/workflows/ci.yml`, running the identical command.

## Amendments to the PRD, recorded in its entry

1. `evals/run.py` became `evals/run.ts` — nothing else here is Python, and the
   runner's whole job is to import the code the app runs.
2. LLM-as-judge groundedness, cost and p95 latency moved to `README.md`'s TODO.
3. Model-dependent metrics report `skip`, never a pass, when no key is present.

## What it caught on its first run

`una-05` ("what is the office wifi password?") scored 0.791 against a relevance
floor of 0.78, so an unanswerable question retrieved five confident chunks and
`abstention` went red at 4/5. Migration `20260819200000` had measured that floor
against three unrelated queries; twenty cases found the fourth. Floor raised to
0.80 in `lib/rag/search.ts`, recall@5 unaffected at 1.00.

## What it caught the second time — pointed at a real provider

Groq validates tool arguments against the published JSON Schema *server-side*,
before the call reaches this process, so a violation is a 400 that ends the
turn rather than a tool error the model can correct. Both defects below were
invisible against Anthropic.

1. **`.optional()` rejected an explicit `null`.** Models routinely fill an
   omitted optional that way. `get_revenue_summary` failed on every metric
   case. All tool optionals are `.nullish()` now.
2. **A published `max()` killed the turn.** `search_documents` declared `limit`
   at most 8; a model asked for 10. The rule that came out: types in the
   schema, value bounds in the tool body (`lib/agent/tools/clamp.ts`), with a
   test asserting no `maxLength`, `minLength` or `pattern` is ever published.

Plus two of mine: the route collapsed every provider fault into one opaque
500, so a rate limit looked like a broken deployment; and the shipped Groq
default model was written from memory and does not exist.

**Result, `groq/openai/gpt-oss-20b`, 2026-08-19:** all five metrics 1.00,
every case scored. A case that never reached the model is now counted as
unscored rather than as a miss — a metric that goes red on a rate limit is a
gate people learn to override — but the run still exits non-zero, because a
measurement that did not happen is not a measurement that passed.

## Open

- The workflow has never executed — no git remote (`README.md` TODO).
- The margin is thin: 0.791 unrelated against 0.803 for the weakest relevant
  chunk still in range. Wants a bigger dataset.
- The SQL default for `min_similarity` is still 0.78. Every caller passes the
  value explicitly, so it only affects a hand-written RPC call; folding it in
  belongs to the next migration that touches the function.
