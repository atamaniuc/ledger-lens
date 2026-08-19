"use client";

import { useEffect, useState } from "react";
import { fetchLineage, type LineageRecord } from "@/lib/dashboard/queries";
import { createClient } from "@/lib/supabase/browser-client";
import { Panel, PanelError, EmptyState } from "@/components/ui/status-badge";
import { useSelection, type Selection } from "./selection-context";

// US-05. Where a number came from: the run, the source, and the raw payload.
//
// Client-side, and one of only two components that are. The reader has to ask
// for this — it is a drill-down — so fetching it during the server render
// would pay for it on every page load whether or not anyone opens it.
//
// It reads through `browser-client`, the same user JWT the server render
// used, so the rows it can see are the rows RLS lets through. There is no
// `org_id` filter here either, for the same reason there is none anywhere
// else (ADR 0007).

type State =
  | { kind: "loading" }
  | { kind: "loaded"; records: LineageRecord[] }
  | { kind: "failed"; message: string };

export function LineageDrillDown() {
  const { selection, clear } = useSelection();
  if (!selection) return null;

  // Keyed on the selection so a different figure remounts this rather than
  // resetting it. Resetting would mean a setState in the effect body, which
  // is a cascading render — and the mount already starts in `loading`, so
  // there is no idle state to return to.
  return (
    <LineagePanel key={selection.label} selection={selection} onClose={clear} />
  );
}

function LineagePanel({
  selection,
  onClose,
}: {
  selection: Selection;
  onClose: () => void;
}) {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const result = await fetchLineage(createClient(), selection.lineage);
      if (cancelled) return;
      setState(
        result.ok
          ? { kind: "loaded", records: result.data }
          : { kind: "failed", message: result.error },
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [selection]);

  return (
    <Panel
      title={`Lineage · ${selection.label}`}
      testId="lineage"
      action={
        <button
          type="button"
          onClick={onClose}
          className="text-xs font-medium text-accent hover:underline"
        >
          Close
        </button>
      }
    >
      {state.kind === "loading" && (
        <p data-testid="lineage-loading" className="text-sm text-muted">
          Loading the records behind this figure…
        </p>
      )}

      {state.kind === "failed" && <PanelError message={state.message} />}

      {state.kind === "loaded" && state.records.length === 0 && (
        <EmptyState>
          No raw records are visible for this figure. If it was produced by
          another tenant&apos;s run, that is the expected result rather than an
          error.
        </EmptyState>
      )}

      {state.kind === "loaded" && state.records.length > 0 && (
        <ul data-testid="lineage-records" className="flex flex-col gap-tight">
          {state.records.map((record) => (
            <li
              key={record.id}
              className="rounded-control bg-surface-sunken px-snug py-tight"
            >
              <p className="flex flex-wrap gap-snug text-xs text-muted">
                <span className="font-mono text-foreground">
                  {record.external_id}
                </span>
                <span>via {record.source}</span>
                <span>run {record.run_id.slice(0, 8)}</span>
                <span>{record.ingested_at.slice(0, 19).replace("T", " ")}</span>
              </p>
              <details className="mt-tight">
                <summary className="cursor-pointer text-xs text-accent">
                  Raw payload
                </summary>
                <pre className="mt-tight overflow-x-auto rounded-control bg-surface p-tight font-mono text-xs text-muted">
                  {JSON.stringify(record.payload, null, 2)}
                </pre>
              </details>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
