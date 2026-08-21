// Shared by both ingestion paths (polling route and provider-webhook Edge
// Function). `EVENT_VERSION` is part of `raw_events`' idempotency key, so
// the two paths drifting on its value would silently create duplicate raw
// events for the same upstream record — the one thing Stage 2 exists to
// prevent. Keeping both constants here makes that drift impossible.
export const EVENT_VERSION = "1";
export const PIPELINE_VERSION = "1";

/**
 * What `public.ingest_raw_event` returns. Hand-written because the project
 * generated types do not cover function return shapes, so `supabase.rpc()`
 * untyped: the RPC return shape is not part of the generated types.
 *
 * - `written` — new raw event, valid, an invoices row was created.
 * - `quarantined` — new raw event, invalid, a quarantine row was created.
 * - `duplicate` — already ingested *and* already has a downstream row.
 *   This is US-03's idempotency guarantee; it is not an error.
 */
export interface IngestOutcome {
  outcome: "written" | "quarantined" | "duplicate";
  raw_event_id: number;
}
