# LedgerLens — Product (one screen)

## Problem
Most portfolios show a "chat with your PDF" wrapper. The target role demands
three things at once — product full-stack delivery, reliable data pipelines,
safe agentic AI — and an LLM layered on unvalidated data does not fix bad data:
it makes wrong numbers sound more convincing, the exact failure mode a
fintech/data employer is afraid of. LedgerLens is built to demonstrate all
three axes against each other, not one of them.

## Who it is for
- **Primary:** technical interviewers / hiring panels evaluating the
  combination of full-stack, data-pipeline and safe-AI judgment.
- **In-fiction:** a small investment firm's ops team that must trust this
  month's numbers before closing the books.

## The one screen
Sign in (magic link) → a single dashboard page: metric tiles, freshness
badge, Data Health panel (4 quality checks), invoices table with lineage
drill-down, and the copilot chat panel. No second screen, no navigation.

## Three killer features
1. **Adversarial provider → zero drift.** A mock provider that duplicates,
   drifts schema, rate-limits and 500s. Ingestion is idempotent
   (`unique(org_id, source, external_id, event_version)` + `ON CONFLICT DO
   NOTHING`), and reconciliation drift is measured at **exactly 0** — the
   provider's independent total 52,417,661 equals invoiced 47,942,632 plus
   quarantined-but-recoverable 4,475,029.
2. **Injection containment by capability, not by prompt.** Exactly 4 tools,
   all read/draft, and no send capability exists anywhere in the system. A
   poisoned document can only *try*: the attempt fails on the tool registry
   and lands in `audit_log`. Safety is a capability boundary, not a
   system-prompt instruction.
3. **Lineage drill-down.** Every number on the screen drills to contributing
   `raw_events`, `run_id`, source and timestamp, down to the raw payload.
   Copilot citations are deterministically verified against the retrieved
   context; an uncited or fabricated citation is flagged, never silently
   trusted.

## Success criteria (measured, not asserted)
- **Reconciliation drift exactly 0**; the before/after idempotency pair is a
  fixed artifact (nonzero → 0), not a runtime toggle.
- **recall@5 = 1.00** on the fixed eval query set (bar ≥ 0.8); every target
  at rank 1.
- **Citation validity bar 0.95**; the current honest reading is 0.50 — the
  gate is deliberately red until fixed (D-25).
- **Abstention 100%** on unanswerable cases; **injection safety 100%**.
- **Relevance floor 0.80**, measured (0.78 measured → raised by the eval
  set); a property of `gte-small`/this corpus, re-measured, not inherited.
- **Eval dataset ≥ 60 cases** (currently 20) gating merges in CI; thresholds
  versioned in `evals/thresholds.json`.
- **RLS proven by test**: a non-owner `org_id` returns empty, not
  error-masked data — through the dashboard, the agent and direct SQL.
- Running system, measured 2026-08-21: **175 unit tests** (not the 146 the
  retired docs claimed) and **96 Playwright tests**, of which 88 pass, 1 fails
  on an embed-function 503 that takes 6 more with it (D-47) and 1 is skipped;
  corpus 366 chunks; two tenants.

## Non-goals
- Production multi-tenant billing or horizontal scale.
- Accounting-software parity (this is not QuickBooks).
- Mobile app / native client; i18n.
- Cross-session long-term memory for the agent (per-conversation history only,
  spec 0013).
- A paid model tier: every provider used must have a free tier, reached
  through the failover chain in decision 0010. Rotating several keys of one
  provider to defeat its own limit is explicitly not done.
