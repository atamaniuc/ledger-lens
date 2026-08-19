"use client";

import type { RunSummary } from "@/lib/dashboard/queries";
import { Panel, StatusBadge, EmptyState } from "@/components/ui/status-badge";
import { useLive } from "./live-refresh";

// US-06. Pipeline runs, updating without a reload.
//
// A **consumer** of the refresh bridge, not a second subscriber. The channel,
// the table list and the event list all live in `live-refresh.tsx`; this
// component opens nothing. Two channels would mean two declarations of what
// is in scope and only one of them covered by the contract test.
//
// The rows come from the server render. When the bridge hears something it
// calls `router.refresh()`, the server re-queries under the same policies,
// and these props arrive already updated — which is why a "live" panel needs
// no fetching of its own.

const RUN_STATE = {
  succeeded: "pass",
  failed: "fail",
  running: "unknown",
} as const;

export function PipelineStatusLive({ runs }: { runs: RunSummary[] }) {
  const { state } = useLive();

  return (
    <Panel
      title="Pipeline runs"
      testId="pipeline-status"
      action={
        state === "live" ? (
          <StatusBadge state="pass" label="Live" />
        ) : state === "connecting" ? (
          <StatusBadge state="unknown" label="Connecting…" />
        ) : (
          // Say it out loud. A frozen panel that still looks live is the same
          // false-green failure in a different costume.
          <StatusBadge state="warn" label="Not live · reload to update" />
        )
      }
    >
      {runs.length === 0 ? (
        <EmptyState>No pipeline runs yet.</EmptyState>
      ) : (
        <ul data-testid="run-rows" className="flex flex-col gap-tight">
          {runs.map((run) => (
            <li
              key={run.id}
              data-run-id={run.id}
              className="flex items-center justify-between gap-gutter rounded-control bg-surface-sunken px-snug py-tight"
            >
              <span className="flex flex-col">
                <span className="font-mono text-xs text-foreground">
                  {run.id.slice(0, 8)}
                </span>
                <span className="text-xs text-muted">
                  {run.kind} · {run.source} ·{" "}
                  {(run.finished_at ?? run.started_at).slice(11, 19)}
                </span>
              </span>
              <StatusBadge
                state={RUN_STATE[run.status as keyof typeof RUN_STATE] ?? "unknown"}
                label={run.status}
              />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
