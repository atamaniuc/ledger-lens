// Shared fixtures for the dashboard panel stories and component tests.
//
// One set of truth: the story that documents what "empty" looks like and the
// test that asserts it render the same objects, so a state that the story
// shows and the test checks cannot drift apart. No hex, no px — this file is
// scanned by the design-token gate like every other file under components/.

import type { AgentTurnResult } from "@/features/agent/loop";
import type { CheckResult } from "@/features/quality/constants";
import type { Freshness } from "@/features/dashboard/freshness";
import type { Metrics } from "@/features/dashboard/metrics";
import type {
  DataHealth,
  InvoicePage,
  InvoiceRow,
  LineageRecord,
  RunSummary,
} from "@/features/dashboard/queries";

// --- runs -------------------------------------------------------------------

const RUN: RunSummary = {
  id: "run_01JZ0K7Y8Q9X2W3V4N5M6L7K",
  kind: "scheduled",
  source: "mock-provider",
  status: "succeeded",
  started_at: "2026-08-21T09:00:00.000Z",
  finished_at: "2026-08-21T09:01:12.000Z",
  rows_read: 248,
  rows_written: 245,
  rows_quarantined: 3,
  rows_deduplicated: 0,
};

const RUN_RUNNING: RunSummary = {
  ...RUN,
  id: "run_01JZ0K9ABC1234567890DEFGH",
  status: "running",
  finished_at: null,
};

const RUN_FAILED: RunSummary = {
  ...RUN,
  id: "run_01JZ0K9XYZ9876543210UVWX",
  status: "failed",
};

export const RECENT_RUNS: RunSummary[] = [RUN_RUNNING, RUN, RUN_FAILED];

// --- data health -------------------------------------------------------------

const CHECK_PASS: CheckResult = {
  check_name: "freshness",
  status: "pass",
  observed: 72,
  expected: 240,
  delta: 0,
  details: null,
};

const CHECK_WARN: CheckResult = {
  check_name: "volume",
  status: "warn",
  observed: 180,
  expected: 245,
  delta: -0.265,
  details: null,
};

const CHECK_FAIL: CheckResult = {
  check_name: "uniqueness",
  status: "fail",
  observed: 4,
  expected: 0,
  delta: 4,
  details: { duplicates: ["INV-2026-001", "INV-2026-002"] },
};

const CHECK_RECONCILIATION: CheckResult = {
  check_name: "reconciliation",
  status: "pass",
  observed: 245,
  expected: 245,
  delta: 0,
  details: null,
};

/** A run with every check present and a fail verdict. */
export const HEALTH_DEFAULT: DataHealth = {
  run: RUN,
  cells: [
    { check_name: "freshness", state: "present", result: CHECK_PASS },
    { check_name: "volume", state: "present", result: CHECK_WARN },
    { check_name: "uniqueness", state: "present", result: CHECK_FAIL },
    { check_name: "reconciliation", state: "present", result: CHECK_RECONCILIATION },
  ],
  verdict: "fail",
  noVerdict: false,
};

/** A run that closed without recording any checks. Not a pass. */
export const HEALTH_NO_VERDICT: DataHealth = {
  run: RUN,
  cells: [
    { check_name: "freshness", state: "missing" },
    { check_name: "volume", state: "missing" },
    { check_name: "uniqueness", state: "missing" },
    { check_name: "reconciliation", state: "missing" },
  ],
  verdict: null,
  noVerdict: true,
};

/** A run with some checks missing — distinct from no-verdict. */
export const HEALTH_MISSING_CHECKS: DataHealth = {
  run: RUN,
  cells: [
    { check_name: "freshness", state: "present", result: CHECK_PASS },
    { check_name: "volume", state: "missing" },
    { check_name: "uniqueness", state: "missing" },
    { check_name: "reconciliation", state: "present", result: CHECK_RECONCILIATION },
  ],
  verdict: "pass",
  noVerdict: false,
};

/** The org has never completed a run. An empty state, not an error. */
export const HEALTH_EMPTY: DataHealth = {
  run: null,
  cells: [],
  verdict: null,
  noVerdict: false,
};

// --- metrics -----------------------------------------------------------------

export const METRICS_DEFAULT: Metrics = {
  invoiceCount: 245,
  totalCents: 125000000,
  averageCents: 510204,
  currency: "USD",
  mixedCurrency: false,
};

export const METRICS_EMPTY: Metrics = {
  invoiceCount: 0,
  totalCents: 0,
  averageCents: null,
  currency: null,
  mixedCurrency: false,
};

export const METRICS_MIXED_CURRENCY: Metrics = {
  invoiceCount: 12,
  totalCents: 0,
  averageCents: null,
  currency: null,
  mixedCurrency: true,
};

// --- invoices ----------------------------------------------------------------

const INVOICE_ROW: InvoiceRow = {
  id: "inv_01JZ0K7Y8Q9X2W3V4N5M6L7K8",
  external_id: "INV-2026-0841",
  customer: "Northwind Traders",
  amount_cents: 482100,
  currency: "USD",
  status: "paid",
  issued_at: "2026-08-18T00:00:00.000Z",
  run_id: RUN.id,
  raw_event_id: 1042,
};

export const INVOICES_DEFAULT: InvoicePage = {
  rows: [
    { ...INVOICE_ROW },
    {
      ...INVOICE_ROW,
      id: "inv_01JZ0K9ABC1234567890DEFGH",
      external_id: "INV-2026-0840",
      customer: "Contoso Ltd",
      amount_cents: 120050,
      status: "overdue",
      issued_at: "2026-08-17T00:00:00.000Z",
      raw_event_id: 1041,
    },
    {
      ...INVOICE_ROW,
      id: "inv_01JZ0K9XYZ9876543210UVWX",
      external_id: "INV-2026-0839",
      customer: "Fabrikam GmbH",
      amount_cents: 960000,
      currency: "EUR",
      status: "pending",
      issued_at: "2026-08-16T00:00:00.000Z",
      raw_event_id: 1040,
    },
  ],
  nextCursor: { issuedAt: "2026-08-16T00:00:00.000Z", id: "inv_01JZ0K9XYZ9876543210UVWX" },
};

export const INVOICES_EMPTY: InvoicePage = { rows: [], nextCursor: null };

// --- freshness ---------------------------------------------------------------

export const FRESHNESS_FRESH: Freshness = {
  state: "fresh",
  ingestedAt: new Date("2026-08-21T10:00:00.000Z"),
  ageMs: 60_000,
};

export const FRESHNESS_STALE: Freshness = {
  state: "stale",
  ingestedAt: new Date("2026-08-20T10:00:00.000Z"),
  ageMs: 86_400_000,
};

export const FRESHNESS_EMPTY: Freshness = { state: "empty" };

export const FRESHNESS_UNKNOWN: Freshness = { state: "unknown" };

// --- lineage -----------------------------------------------------------------

export const LINEAGE_SELECTION = {
  label: "Total invoiced",
  lineage: { runIds: [RUN.id], rawEventIds: [1042, 1041] },
};

export const LINEAGE_RECORDS: LineageRecord[] = [
  {
    id: 1042,
    external_id: "INV-2026-0841",
    source: "mock-provider",
    ingested_at: "2026-08-18T01:00:00.000Z",
    run_id: RUN.id,
    payload: {
      external_id: "INV-2026-0841",
      customer: "Northwind Traders",
      amount_cents: 482100,
    },
  },
  {
    id: 1041,
    external_id: "INV-2026-0840",
    source: "mock-provider",
    ingested_at: "2026-08-17T01:00:00.000Z",
    run_id: RUN.id,
    payload: { external_id: "INV-2026-0840", customer: "Contoso Ltd" },
  },
];

// --- copilot ----------------------------------------------------------------

export const AGENT_ANSWER: AgentTurnResult & { correlation_id: string } = {
  answer:
    "Three invoices are overdue: [invoice:INV-2026-0840], [invoice:INV-2026-0838] and [invoice:INV-2026-0837]. Your standard terms are net-30.",
  outcome: "ok",
  terminationReason: null,
  steps: 3,
  toolsUsed: ["search_invoices", "read_invoice"],
  retrievedChunkIds: [],
  citedInvoiceIds: ["INV-2026-0840", "INV-2026-0838", "INV-2026-0837"],
  citations: [
    { kind: "invoice", id: "INV-2026-0840", verified: true },
    { kind: "invoice", id: "INV-2026-0838", verified: true },
    { kind: "invoice", id: "INV-2026-0837", verified: false },
  ],
  verified: false,
  uncited: false,
  usage: { inputTokens: 812, outputTokens: 96 },
  correlation_id: "corr_01JZ0K7Y8Q9X2W3V4N5M6L7K",
};

export const AGENT_ANSWER_UNCITED: AgentTurnResult & { correlation_id: string } = {
  ...AGENT_ANSWER,
  answer: "The pipeline processed 245 invoices in the last run.",
  citations: [],
  citedInvoiceIds: [],
  verified: false,
  uncited: true,
  correlation_id: "corr_01JZ0K9ABC1234567890DEFGH",
};

export const AGENT_ANSWER_ABSTAINED: AgentTurnResult & { correlation_id: string } = {
  ...AGENT_ANSWER,
  answer: "",
  outcome: "abstained",
  terminationReason: null,
  citations: [],
  citedInvoiceIds: [],
  verified: true,
  uncited: true,
  correlation_id: "corr_01JZ0K9XYZ9876543210UVWX",
};

// Convenience: an ok:true QueryResult wrapper for the panels that take one.
export function okResult<T>(data: T) {
  return { ok: true as const, data };
}

export function errorResult(message: string) {
  return { ok: false as const, error: message };
}
