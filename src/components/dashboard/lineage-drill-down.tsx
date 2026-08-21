"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { fetchLineage } from "@/features/dashboard/queries";
import { createClient } from "@/platform/supabase/browser-client";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, Panel, PanelError } from "@/components/ui/status-badge";
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

export function LineageDrillDown() {
  const { selection, clear } = useSelection();
  if (!selection) return null;

  // Keyed on the selection so a different figure remounts this rather than
  // resetting it — the query key below would do the same work, but the panel
  // also has scroll position and open `<details>` elements that should not
  // survive a change of subject.
  return (
    <LineagePanel key={selection.label} selection={selection} onClose={clear} />
  );
}

/**
 * The drawer itself, exported so stories and component tests can drive it
 * without going through a click on a metric tile. "fetchLineageFn" is
 * injectable for the same reason: the states a story or test needs (loading,
 * empty, error) are states of a query, and controlling the query is easier
 * than stubbing the transport.
 */
export function LineagePanel({
  selection,
  onClose,
  fetchLineageFn = fetchLineage,
}: {
  selection: Selection;
  onClose: () => void;
  fetchLineageFn?: typeof fetchLineage;
}) {
  // Cached by what is being looked at, so re-opening the same figure inside
  // the stale window is free. There is no "org_id" in the key for the same
  // reason there is none in the query (ADR 0007) — the client carries the
  // user's JWT, and a key that pretended to scope would be a second, wrong
  // copy of a rule Postgres already enforces.
  const query = useQuery({
    queryKey: ["lineage", selection.lineage.rawEventIds],
    queryFn: async () => {
      const result = await fetchLineageFn(createClient(), selection.lineage);
      if (!result.ok) throw new Error(result.error);
      return result.data;
    },
  });

  // The drawer is a drill-down the reader asked for: focus follows them into
  // it, and Escape returns them (T8). The close button is the first
  // focusable element in the panel.
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <Panel
      title={`Lineage · ${selection.label}`}
      testId="lineage"
      ariaLabel={`Lineage for ${selection.label}`}
      action={
        <Button
          ref={closeButton}
          type="button"
          variant="ghost"
          size="xs"
          data-testid="lineage-close"
          onClick={onClose}
        >
          Close
        </Button>
      }
    >
      {query.isPending && (
        <div data-testid="lineage-loading" className="flex flex-col gap-tight">
          <p className="text-sm text-muted-foreground">
            Loading the records behind this figure…
          </p>
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      )}

      {query.isError && (
        <div className="flex flex-col items-start gap-snug">
          <PanelError message={query.error.message} retry={false} />
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="lineage-retry"
            onClick={() => void query.refetch()}
          >
            Try again
          </Button>
        </div>
      )}

      {query.isSuccess && query.data.length === 0 && (
        <EmptyState>
          No raw records are visible for this figure. If it was produced by
          another tenant&apos;s run, that is the expected result rather than an
          error.
        </EmptyState>
      )}

      {query.isSuccess && query.data.length > 0 && (
        <ul data-testid="lineage-records" className="flex flex-col gap-tight">
          {query.data.map((record) => (
            <li
              key={record.id}
              className="rounded-control bg-muted px-snug py-tight"
            >
              <p className="flex flex-wrap gap-snug text-xs text-muted-foreground">
                <span className="font-mono text-foreground">
                  {record.external_id}
                </span>
                <span>via {record.source}</span>
                <span>run {record.run_id.slice(0, 8)}</span>
                <span>{record.ingested_at.slice(0, 19).replace("T", " ")}</span>
              </p>
              <details className="mt-tight">
                <summary className="cursor-pointer rounded-control text-xs text-primary outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                  Raw payload
                </summary>
                <pre className="mt-tight overflow-x-auto rounded-control bg-card p-tight font-mono text-xs text-muted-foreground">
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
