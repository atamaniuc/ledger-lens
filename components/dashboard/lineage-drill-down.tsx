"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchLineage } from "@/lib/dashboard/queries";
import { createClient } from "@/lib/supabase/browser-client";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
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

function LineagePanel({
  selection,
  onClose,
}: {
  selection: Selection;
  onClose: () => void;
}) {
  // Cached by what is being looked at, so re-opening the same figure inside
  // the stale window is free. There is no `org_id` in the key for the same
  // reason there is none in the query (ADR 0007) — the client carries the
  // user's JWT, and a key that pretended to scope would be a second, wrong
  // copy of a rule Postgres already enforces.
  const query = useQuery({
    queryKey: ["lineage", selection.lineage.rawEventIds],
    queryFn: async () => {
      const result = await fetchLineage(createClient(), selection.lineage);
      if (!result.ok) throw new Error(result.error);
      return result.data;
    },
  });

  return (
    <Panel
      title={`Lineage · ${selection.label}`}
      testId="lineage"
      action={
        <Button type="button" variant="ghost" size="xs" onClick={onClose}>
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

      {query.isError && <PanelError message={query.error.message} />}

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
                <summary className="cursor-pointer text-xs text-primary">
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
