import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CHECK_NAMES,
  type CheckName,
  type CheckResult,
  type CheckStatus,
  worstStatus,
} from "@/lib/data-quality/constants";
import type { Database } from "@/lib/supabase/database.types";
import { classifyFreshness, type Freshness } from "./freshness";
import { deriveMetrics, type Metrics } from "./metrics";

// Every read the dashboard makes, in one place.
//
// None of these filter by `org_id`. That is the point of ADR 0007: the client
// passed in carries the signed-in user's JWT, the query goes to Postgres as
// `authenticated`, and the RLS policy decides what comes back. A `where
// org_id = …` here would be a second, hand-maintained copy of a rule the
// database already enforces — and the copy is the one that gets forgotten.
//
// Each function returns a discriminated result rather than throwing. A panel
// whose query failed renders its own error state; one failing tile must not
// blank the page.

type Client = SupabaseClient<Database>;

export type QueryResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

function failed(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}

/** US-03. How long ago anything was ingested for the orgs this user can see. */
export async function fetchFreshness(
  supabase: Client,
  now: Date = new Date(),
): Promise<QueryResult<Freshness>> {
  const { data, error } = await supabase
    .from("raw_events")
    .select("ingested_at")
    .order("ingested_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // `unknown`, never `fresh`. There is no failure mode here that renders as
  // up-to-date data.
  if (error) return failed(error.message);

  return { ok: true, data: classifyFreshness(data?.ingested_at ?? null, now) };
}

/** US-02. The headline figures. */
export async function fetchMetrics(supabase: Client): Promise<QueryResult<Metrics>> {
  const { data, error } = await supabase
    .from("invoices")
    .select("amount_cents, currency");

  if (error) return failed(error.message);
  return { ok: true, data: deriveMetrics(data ?? []) };
}

export interface RunSummary {
  id: string;
  kind: string;
  source: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  rows_read: number;
  rows_written: number;
  rows_quarantined: number;
  rows_deduplicated: number;
}

/**
 * A check as the panel renders it. `missing` is a real state and is not the
 * same as failing: Stage 3 writes four rows per run, but the ingestion route
 * catches a checks failure and continues, so a closed run can legitimately
 * carry fewer than four — or none.
 */
export type CheckCell =
  | { check_name: CheckName; state: "present"; result: CheckResult }
  | { check_name: CheckName; state: "missing" };

export interface DataHealth {
  /** `null` when the org has never completed a run. An empty state, not an error. */
  run: RunSummary | null;
  cells: CheckCell[];
  /** The worst status among the checks that exist. `null` when none do. */
  verdict: CheckStatus | null;
  /** True when the run closed without producing a single result row. */
  noVerdict: boolean;
}

/**
 * US-04. The newest *closed* run and the verdict attached to it.
 *
 * Two properties this has to get right, both of which the obvious query gets
 * wrong:
 *
 *   * The run is selected regardless of whether it has results. Selecting the
 *     newest run that *has* results would silently show an older run's
 *     verdict next to the newest run's row, which reads as a fresh pass.
 *   * Results accumulate rather than upsert — a retried run can hold more
 *     than one row per check (see the Stage 3 migration's own comment) — so
 *     only the newest row per `check_name` counts. Postgres would express
 *     that as `distinct on (run_id, check_name) … order by created_at desc,
 *     id desc`; PostgREST cannot, so the ordering is asked for and the
 *     deduplication is done here, over one run's handful of rows. `id desc`
 *     breaks a `created_at` tie, which a single transaction writing four rows
 *     makes likely rather than theoretical.
 */
export async function fetchDataHealth(
  supabase: Client,
): Promise<QueryResult<DataHealth>> {
  const { data: run, error: runError } = await supabase
    .from("pipeline_runs")
    .select(
      "id, kind, source, status, started_at, finished_at, rows_read, rows_written, rows_quarantined, rows_deduplicated",
    )
    .in("status", ["succeeded", "failed"])
    .order("finished_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (runError) return failed(runError.message);
  if (!run) {
    return {
      ok: true,
      data: { run: null, cells: [], verdict: null, noVerdict: false },
    };
  }

  const { data: rows, error: checksError } = await supabase
    .from("data_quality_results")
    .select("check_name, status, observed, expected, delta, details, created_at, id")
    .eq("run_id", run.id)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });

  if (checksError) return failed(checksError.message);

  return { ok: true, data: buildDataHealth(run, rows ?? []) };
}

/** The deduplication and roll-up, split out so it can be tested directly. */
export function buildDataHealth(
  run: RunSummary,
  // Newest first: the caller orders by created_at desc, id desc.
  rows: readonly {
    check_name: string;
    status: string;
    observed: number | null;
    expected: number | null;
    delta: number | null;
    details: unknown;
  }[],
): DataHealth {
  const newest = new Map<string, CheckResult>();
  for (const row of rows) {
    // First occurrence wins because the rows arrive newest-first. A later
    // row for the same check is a superseded attempt.
    if (newest.has(row.check_name)) continue;
    newest.set(row.check_name, {
      check_name: row.check_name as CheckName,
      status: row.status as CheckStatus,
      observed: row.observed,
      expected: row.expected,
      delta: row.delta,
      details: (row.details ?? null) as Record<string, unknown> | null,
    });
  }

  // Always four cells, in a fixed order, so the panel's shape does not depend
  // on which checks happened to run.
  const cells: CheckCell[] = CHECK_NAMES.map((check_name) => {
    const result = newest.get(check_name);
    return result
      ? { check_name, state: "present" as const, result }
      : { check_name, state: "missing" as const };
  });

  const present = cells.flatMap((c) => (c.state === "present" ? [c.result] : []));

  return {
    run,
    cells,
    verdict: present.length > 0 ? worstStatus(present) : null,
    noVerdict: present.length === 0,
  };
}

/** US-06. The recent runs the live panel lists. Newest first. */
export async function fetchRecentRuns(
  supabase: Client,
  limit = 8,
): Promise<QueryResult<RunSummary[]>> {
  const { data, error } = await supabase
    .from("pipeline_runs")
    .select(
      "id, kind, source, status, started_at, finished_at, rows_read, rows_written, rows_quarantined, rows_deduplicated",
    )
    // `started_at`, not `finished_at`: a run still going has no finish time,
    // and a live panel that hides in-flight runs until they end is not live.
    .order("started_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);

  if (error) return failed(error.message);
  return { ok: true, data: data ?? [] };
}

// --- invoices, cursor-paginated ---------------------------------------------

export const INVOICE_PAGE_SIZE = 25;

export interface InvoiceRow {
  id: string;
  external_id: string;
  customer: string;
  amount_cents: number;
  currency: string;
  status: string;
  issued_at: string;
  run_id: string;
  raw_event_id: number;
}

/**
 * Where a page of invoices starts. Keyset, not offset: `(issued_at, id)`
 * descending. Offset paging over a table the pipeline is still writing to
 * skips and repeats rows as earlier pages shift underneath the reader, and
 * `issued_at` alone is not unique — a batch shares a timestamp — so the id
 * breaks the tie and makes the order total.
 */
export interface InvoiceCursor {
  issuedAt: string;
  id: string;
}

export interface InvoicePage {
  rows: InvoiceRow[];
  /** Pass back as `after` for the next page. `null` at the end. */
  nextCursor: InvoiceCursor | null;
}

export function encodeCursor(cursor: InvoiceCursor): string {
  return `${cursor.issuedAt}|${cursor.id}`;
}

/** Returns `null` for anything malformed; a bad cursor starts from the top. */
export function decodeCursor(raw: string | null | undefined): InvoiceCursor | null {
  if (!raw) return null;
  const separator = raw.indexOf("|");
  if (separator <= 0) return null;

  const issuedAt = raw.slice(0, separator);
  const id = raw.slice(separator + 1);
  if (!id || Number.isNaN(Date.parse(issuedAt))) return null;

  return { issuedAt, id };
}

export async function fetchInvoicePage(
  supabase: Client,
  after: InvoiceCursor | null = null,
  pageSize: number = INVOICE_PAGE_SIZE,
): Promise<QueryResult<InvoicePage>> {
  let query = supabase
    .from("invoices")
    .select(
      "id, external_id, customer, amount_cents, currency, status, issued_at, run_id, raw_event_id",
    )
    .order("issued_at", { ascending: false })
    .order("id", { ascending: false })
    // One extra row is the end-of-list probe: if it comes back there is a
    // next page, and asking that way costs one row rather than a count query
    // over the whole table.
    .limit(pageSize + 1);

  if (after) {
    query = query.or(
      `issued_at.lt.${after.issuedAt},and(issued_at.eq.${after.issuedAt},id.lt.${after.id})`,
    );
  }

  const { data, error } = await query;
  if (error) return failed(error.message);

  const all = data ?? [];
  const rows = all.slice(0, pageSize);
  const last = rows.at(-1);

  return {
    ok: true,
    data: {
      rows,
      nextCursor:
        all.length > pageSize && last
          ? { issuedAt: last.issued_at, id: last.id }
          : null,
    },
  };
}

// --- lineage ------------------------------------------------------------------

/**
 * US-05. What a selected figure was built from: the run that produced it and
 * the raw events behind it. Carried through the selection context rather than
 * refetched, so clicking a tile costs no round trip until the drawer opens.
 */
export interface LineagePayload {
  runIds: string[];
  rawEventIds: number[];
}

export interface LineageRecord {
  id: number;
  external_id: string;
  source: string;
  ingested_at: string;
  payload: unknown;
  run_id: string;
}

export async function fetchLineage(
  supabase: Client,
  payload: LineagePayload,
): Promise<QueryResult<LineageRecord[]>> {
  if (payload.rawEventIds.length === 0) return { ok: true, data: [] };

  const { data, error } = await supabase
    .from("raw_events")
    .select("id, external_id, source, ingested_at, payload, run_id")
    .in("id", payload.rawEventIds)
    .order("ingested_at", { ascending: false });

  if (error) return failed(error.message);
  return { ok: true, data: data ?? [] };
}
