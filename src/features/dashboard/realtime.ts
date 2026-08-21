// What the dashboard's Realtime subscription is allowed to listen to.
//
// Declared once, exported, and asserted by a test. The migration pins which
// tables are *published*; a publication cannot express which events a client
// asks for, so that half of the contract lives here.
//
// INSERT and UPDATE only, never `*`. RLS is not applied to DELETE events —
// Postgres cannot verify access to a row that no longer exists — so a `*`
// subscription would broadcast other tenants' primary keys. Nothing in this
// project deletes from either table, which makes the exclusion free today. A
// later change that wants delete events has to solve the leak rather than
// widen this list. See ADR 0007.

export type RealtimeEvent = "INSERT" | "UPDATE";

export interface SubscribedTable {
  table: string;
  events: readonly RealtimeEvent[];
  /** Why this table is here, so a future reader does not have to guess. */
  reason: string;
}

export const SUBSCRIBED_TABLES: readonly SubscribedTable[] = [
  {
    table: "pipeline_runs",
    events: ["INSERT", "UPDATE"],
    reason: "A run appearing, and reaching a terminal state (US-06).",
  },
  {
    table: "data_quality_results",
    events: ["INSERT"],
    reason:
      "The verdict is written after closeRun(), so watching runs alone would " +
      "refresh before it exists and never again. Results are never updated " +
      "in place — a retry inserts a new row — so INSERT is the whole story.",
  },
] as const;

/** One channel name per tab. Shared, because there is exactly one subscriber. */
export const DASHBOARD_CHANNEL = "dashboard-live";

/**
 * How long to wait after an event before refreshing.
 *
 * A completed run writes four `data_quality_results` rows inside one
 * transaction and closes its `pipeline_runs` row around them. Refreshing per
 * event would re-render the server tree five times for one logical change;
 * coalescing inside a short window makes it one. Long enough to catch the
 * batch, short enough that "live" is still true.
 */
export const REFRESH_COALESCE_MS = 400;
