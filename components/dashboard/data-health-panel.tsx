import type { DataHealth, QueryResult } from "@/lib/dashboard/queries";
import {
  EmptyState,
  Panel,
  PanelError,
  StatusBadge,
} from "@/components/ui/status-badge";

// US-04. The four checks from one run, and which run that was.
//
// The states this has to keep apart, because collapsing any two of them turns
// the panel into a confident lie:
//
//   pass / warn / fail  — the check ran and reached a verdict
//   not run             — the run closed without writing this check's row
//   no verdict          — the run closed without writing any of them
//   never run           — the org has never completed a run at all
//
// A failing check is rendered red, in place, and is not collapsible. There is
// no disclosure triangle on this panel on purpose.

const DESCRIPTIONS: Record<string, string> = {
  freshness: "How recently the pipeline ingested anything",
  volume: "This run's row count against its own baseline",
  uniqueness: "Duplicate invoices for one external id",
  reconciliation: "Our accounted total against the provider's own summary",
};

export function DataHealthPanel({ result }: { result: QueryResult<DataHealth> }) {
  if (!result.ok) {
    return (
      <Panel title="Data health" testId="data-health">
        <PanelError message={result.error} />
      </Panel>
    );
  }

  const { run, cells, verdict, noVerdict } = result.data;

  if (!run) {
    return (
      <Panel title="Data health" testId="data-health">
        <EmptyState>
          No pipeline run has completed yet. Trigger an ingestion run to see the
          quality checks for it here.
        </EmptyState>
      </Panel>
    );
  }

  return (
    <Panel
      title="Data health"
      testId="data-health"
      action={
        noVerdict ? (
          <StatusBadge state="unknown" label="No verdict" />
        ) : (
          verdict && <StatusBadge state={verdict} />
        )
      }
    >
      <p className="mb-gutter text-xs text-faint" data-testid="data-health-run">
        Run <span className="font-mono">{run.id.slice(0, 8)}</span> · {run.kind} ·{" "}
        {run.status} · {run.rows_read} read, {run.rows_written} written,{" "}
        {run.rows_quarantined} quarantined
      </p>

      {noVerdict && (
        <p
          role="alert"
          data-testid="no-verdict"
          className="mb-gutter text-sm text-status-unknown"
        >
          This run closed without recording any quality checks. That is not a
          pass — the checks did not report.
        </p>
      )}

      <ul className="flex flex-col gap-tight">
        {cells.map((cell) => (
          <li
            key={cell.check_name}
            data-testid={`check-${cell.check_name}`}
            data-state={cell.state === "present" ? cell.result.status : "missing"}
            className="flex items-start justify-between gap-gutter rounded-control bg-surface-sunken px-snug py-tight"
          >
            <span className="flex flex-col">
              <span className="text-sm font-medium text-foreground">
                {cell.check_name}
              </span>
              <span className="text-xs text-muted">
                {DESCRIPTIONS[cell.check_name]}
              </span>
              {cell.state === "present" && cell.result.delta !== null && (
                <span className="font-mono text-xs text-faint">
                  delta {cell.result.delta}
                </span>
              )}
            </span>
            {cell.state === "present" ? (
              <StatusBadge state={cell.result.status} />
            ) : (
              <StatusBadge state="missing" />
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
