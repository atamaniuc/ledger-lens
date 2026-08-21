import { logDashboard, pageCorrelationId, timed } from "@/features/dashboard/correlation";
import {
  decodeCursor,
  fetchDataHealth,
  fetchFreshness,
  fetchInvoicePage,
  fetchMetrics,
  fetchRecentRuns,
  type LineagePayload,
} from "@/features/dashboard/queries";
import { createClient } from "@/platform/supabase/server-client";
import { CopilotPanel } from "@/components/dashboard/copilot-panel";
import { DataHealthPanel } from "@/components/dashboard/data-health-panel";
import { FreshnessBadge } from "@/components/dashboard/freshness-badge";
import { InvoicesTable } from "@/components/dashboard/invoices-table";
import { LineageDrillDown } from "@/components/dashboard/lineage-drill-down";
import { LiveRefreshProvider } from "@/components/dashboard/live-refresh";
import { MetricTiles } from "@/components/dashboard/metric-tiles";
import { PipelineStatusLive } from "@/components/dashboard/pipeline-status-live";
import { SelectionProvider } from "@/components/dashboard/selection-context";
import { EmptyState, Panel } from "@/components/ui/status-badge";
import { AppHeader } from "@/components/app-header";

// The dashboard. One Server Component that issues every read, and passes the
// results down as props.
//
// Queries live here rather than inside each panel for two reasons: one client
// per render (never a shared module-level one — the session is request
// state), and every panel gets its data from the same JWT in the same round
// of queries, so the page cannot show two panels from two different moments.
//
// The reads run concurrently. They are independent, they all go to the same
// Postgres, and doing them in sequence would make the first paint the sum of
// five latencies instead of the longest one. Every one of them returns a
// result object rather than throwing, so a panel whose query failed renders
// its own error and the rest of the page still renders.

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const correlationId = await pageCorrelationId();
  const params = await searchParams;
  const after = decodeCursor(
    Array.isArray(params.after) ? params.after[0] : params.after,
  );
  const first = (key: string): string | undefined => {
    const value = params[key];
    const raw = Array.isArray(value) ? value[0] : value;
    return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
  };
  // Filters come from the URL so a filtered view is addressable and survives
  // a reload — the same reason the page cursor lives in the query string.
  const filters = {
    customer: first("q"),
    status: first("status"),
  };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { result: panels, durationMs } = await timed(() =>
    Promise.all([
      fetchFreshness(supabase),
      fetchMetrics(supabase),
      fetchDataHealth(supabase),
      fetchInvoicePage(supabase, after, undefined, filters),
      fetchRecentRuns(supabase),
    ]),
  );
  const [freshness, metrics, health, invoices, runs] = panels;

  logDashboard(correlationId, "dashboard.render", {
    user_id: user?.id ?? null,
    duration_ms: durationMs,
    failed_panels: [
      ["freshness", freshness],
      ["metrics", metrics],
      ["data_health", health],
      ["invoices", invoices],
      ["runs", runs],
    ]
      .filter(([, r]) => !(r as { ok: boolean }).ok)
      .map(([name]) => name),
  });

  // The lineage a metric tile opens: the records behind the invoices on this
  // page. Computed here, carried through the selection context, so clicking a
  // tile costs no round trip until the drawer actually opens.
  const lineage: LineagePayload = invoices.ok
    ? {
        runIds: [...new Set(invoices.data.rows.map((r) => r.run_id))],
        rawEventIds: invoices.data.rows.map((r) => r.raw_event_id),
      }
    : { runIds: [], rawEventIds: [] };

  // Signed in, but the policies return nothing anywhere. Not an error: a user
  // who belongs to no org, or an org that has not ingested yet. Rendering
  // that as a failure would teach people to distrust a working system.
  const nothingToShow =
    metrics.ok &&
    metrics.data.invoiceCount === 0 &&
    health.ok &&
    health.data.run === null &&
    runs.ok &&
    runs.data.length === 0;

  return (
    <LiveRefreshProvider correlationId={correlationId}>
      <SelectionProvider>
        <main className="mx-auto flex max-w-6xl flex-col gap-section p-page">
          <AppHeader email={user?.email ?? "unknown"} />
          <FreshnessBadge result={freshness} />

          {nothingToShow ? (
            <Panel title="Nothing here yet" testId="dashboard-empty">
              <EmptyState>
                No data has been ingested for your organisation. Trigger an
                ingestion run and the figures, quality checks and lineage will
                appear here — the page updates on its own as runs complete.
              </EmptyState>
            </Panel>
          ) : (
            <>
              <MetricTiles result={metrics} lineage={lineage} />

              {/* Two thirds of content, one third of state and questions.
                  The copilot sits above the live run list because it is the
                  column's reason for existing (US-07); the run list is what
                  filled the space while the agent did not exist yet. */}
              <div className="grid gap-section lg:grid-cols-3">
                <div className="flex flex-col gap-section lg:col-span-2">
                  <DataHealthPanel result={health} />
                  <InvoicesTable result={invoices} filters={filters} />
                  <LineageDrillDown />
                </div>
                <aside
                  data-testid="copilot-slot"
                  className="flex flex-col gap-section"
                >
                  <CopilotPanel />
                  <PipelineStatusLive
                    runs={runs.ok ? runs.data : []}
                    error={runs.ok ? null : runs.error}
                  />
                </aside>
              </div>
            </>
          )}
        </main>
      </SelectionProvider>
    </LiveRefreshProvider>
  );
}
