# LedgerLens Python Services

py/ is the only Python home in this repo. Two services:

1. **ledgerlens-index** — the bulk corpus indexer (spec 0005, D-42/D-43).
2. **ledgerlens-judge** — the claim-level groundedness judge (spec 0008, D-27/D-03).

## Groundedness judge (spec 0008, D-27/D-03)

The judge is the **second CI signal** behind the deterministic citation check
(src/features/agent/citations.ts): every claim in an answer is decomposed and
checked against the retrieved chunks it was supposed to come from, so an
answer that asserts a number with no citation can no longer pass (D-27), and
the README's "LLM-as-judge blocks the merge" claim becomes a real gate (D-03).

Two halves, deliberately stacked (spec 0008 invariant "the judge is a second
signal; the deterministic citation check stays the first"):

- **Deterministic, model-free**: numbers, currency, ids, dates and totals are
  verified exactly against the retrieved context — a value in the claim that
  is absent from the chunks is `unsupported`; a labelled attribute (`status is
  paid`) with a conflicting value in the chunks is `contradicted`; a negation
  (`no invoices are currently overdue`) with the negated keyword present in
  the chunks is `contradicted`. This half needs no key and no network.
  <!-- proof: py/tests/test_judge_verifiers.py::test_number_found_is_supported -->
  <!-- proof: py/tests/test_judge_verifiers.py::test_negation_contradicted_when_keyword_in_context -->
- **Model, zero-cost, never self-grading**: only the claims the deterministic
  half cannot resolve go to a model. The judge takes a DIFFERENT provider and
  model than the answerer (decisions/0010): it fails loudly (exit 2) when the
  judge model equals the answering model, and it only uses free-tier
  providers (groq, nvidia, an OpenAI-compatible endpoint — never anthropic).
  With no key present it skips loudly and non-zero (exit 1), never a silent
  pass. <!-- proof: py/tests/test_judge_guard.py::test_judge_equal_to_answerer_raises -->
  <!-- proof: py/tests/test_judge_guard.py::test_anthropic_judge_is_rejected -->
  <!-- proof: py/tests/test_judge_cli.py::test_model_bound_claims_without_key_exit_one -->

### Run

    uv run ledgerlens-judge --input cases.jsonl [--output evals/groundedness.json] [--threshold 0.8]

Exit codes: **0** every claim judged and at/above the threshold · **1**
claims went unjudged (no key, model errors) or the score breached the
threshold — a gate that cannot judge is red · **2** configuration or input
error (judge would grade itself, unknown provider, unreadable input).
<!-- proof: py/tests/test_judge_cli.py::test_deterministic_only_run_exits_zero -->
<!-- proof: py/tests/test_judge_cli.py::test_threshold_breach_exits_one -->

### Environment

New keys (read defensively by py/ledgerlens_judge/config.py; the parent must
add them to the zod schema in src/platform/config.ts):

| Key | Meaning |
|---|---|
| JUDGE_PROVIDER | groq (default) | nvidia | openai-compatible — never anthropic |
| JUDGE_MODEL | the judging model (required when the model half runs) |
| JUDGE_API_KEY | the judging provider's key (absent ⇒ loud non-zero skip) |
| JUDGE_BASE_URL | only for JUDGE_PROVIDER=openai-compatible |
| LLM_PROVIDER / LLM_MODEL | the answering model, for the judge-must-differ guard (or per-record `answerer` in the input, or --answerer-*) |

### Input contract (one JSON object per line; the runner lane emits this)

    {"id": "met-01",
     "answer": "Revenue was $12,340 [chunk:5].",
     "retrieved": [{"chunk_id": 5, "title": "March revenue", "text": "..."}],
     "answerer": {"provider": "groq", "model": "gpt-oss-20b"}}   // optional

`id`, `answer`, `retrieved[]` are required; `retrieved[]` is the context the
answer was supposed to come from (what evals/run.ts has in hand when a case
answers). `answerer` is optional per record and overrides the environment.
See evals/run.ts for what the runner produces per case today; the runner lane
writes the same shape to this file.
<!-- proof: py/tests/test_judge_cli.py::test_record_without_retrieved_array_is_rejected -->

### Report contract (schema_version 1.0, default evals/groundedness.json)

    {
      "schema_version": "1.0",
      "generated_at": "…ISO-8601…",
      "correlation_id": "…",
      "answerer": {"provider": "groq", "model": "gpt-oss-20b"},   // null when unknown
      "judge": {"provider": "groq", "model": "llama-3.3-70b-versatile"},  // null when the model half never ran
      "summary": {
        "claims_total": 3, "claims_scored": 3,
        "claims_supported": 2, "claims_unsupported": 1, "claims_contradicted": 0,
        "claims_unscored": 0,
        "deterministic": 2, "model": 1, "uncited_claims": 1,
        "groundedness": 0.6667,          // supported / scored; null when nothing scored
        "incomplete": false              // true ⇒ the gate must fail
      },
      "threshold": {"pass_at": 0.8, "breached": false},   // null when --threshold absent
      "cases": [{"id": "met-01", "claims": [
        {"id": "met-01.0", "text": "…", "cited": true,
         "citations": [{"kind": "chunk", "id": "5"}],
         "method": "exact" | "number" | "date" | "id" | "citation" | "negation" | "label" | "model",
         "verdict": "supported" | "unsupported" | "contradicted" | null,
         "evidence": ["'$12,340' found in chunk 5: …"], "unscored_reason": null}}]}],
      "error": null
    }

The eval runner gates on `summary.groundedness` (>= its threshold in
evals/thresholds.json, version-bumped) and fails the build when
`summary.incomplete` is true — a run that did not judge everything is not a
pass (same rule as the NOT-MEASURED verdict in evals/run.ts).
<!-- proof: py/tests/test_judge_report.py::test_report_schema_and_version -->
<!-- proof: py/tests/test_judge_report.py::test_incomplete_when_claims_unscored -->

## Bulk corpus indexer (spec 0005)

A bulk indexer that replaces the 8-texts-at-a-time Edge path for full-corpus
rebuilds (D-43).

### Contract (AC-03)

- Writes to chunks server-side only, keyed by content_hash: an unchanged
  chunk is never re-embedded or rewritten, so a second run writes nothing.
  It is a CLI script, exactly like task index — never reachable from client
  code.
- correlation_id on every JSON log line; the chunker is byte-for-byte
  identical to src/features/rag/chunk.ts (golden fixtures in tests/fixtures/).

### Run

    uv sync                       # install locked deps (Python 3.12 via uv)
    uv run ledgerlens-index --dry-run         # plan only, no writes
    uv run ledgerlens-index                   # edge backend (default)
    uv run ledgerlens-index --backend local   # needs: uv sync --extra local

Env: DB_URL (default postgresql://postgres:postgres@127.0.0.1:54322/postgres),
SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, EMBED_SHARED_SECRET. Options:
--org-id, --backend {edge,local}, --dry-run, --embed-concurrency, --embed-batch-size (max 8),
--correlation-id.

### Backends (D-47)

- edge (default): the embed Edge Function, 8 texts/request, bounded
  concurrency. Retry policy mirrors src/features/rag/embed.ts (D-47): 5xx
  (503/546) retried with backoff + jitter, 546 batches halve to single
  texts, body carried in the error.
- local (extra [local]): sentence-transformers gte-small — the only embed
  path with no server dependency. Parity with edge (cosine >= 0.999) is
  the gate in tests/test_embed_parity.py.

## Quality gates

    uv run ruff check && uv run ruff format --check && uv run mypy && uv run pytest
DB-backed tests run inside transactions that are always rolled back; they never truncate and never write to seeded tenants (they use a throwaway org).
