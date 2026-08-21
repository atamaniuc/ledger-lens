import { PanelSkeleton } from "@/components/ui/panel-skeleton";
import { Skeleton } from "@/components/ui/skeleton";

// The instant loading state while the dashboard's server render awaits its
// five queries (Next's loading.js convention). Same panel-shaped skeletons
// the loading stories render, in the same three-column layout — so the page
// does not jump when the data lands. One source of skeleton shapes:
// `PanelSkeleton`.
export default function DashboardLoading() {
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-section p-page" aria-busy="true">
      <header className="flex flex-wrap items-center justify-between gap-gutter">
        <div className="flex flex-col gap-tight">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-3 w-40" />
        </div>
        <Skeleton className="h-5 w-36 rounded-control" />
      </header>

      <div data-testid="metric-tiles-loading" className="grid gap-gutter sm:grid-cols-3">
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} className="h-24 rounded-panel" />
        ))}
      </div>

      <div className="grid gap-section lg:grid-cols-3">
        <div className="flex flex-col gap-section lg:col-span-2">
          <PanelSkeleton label="Data health loading" lines={4} />
          <PanelSkeleton label="Invoices loading" lines={5} />
        </div>
        <aside className="flex flex-col gap-section">
          <PanelSkeleton label="Copilot loading" lines={3} />
          <PanelSkeleton label="Pipeline runs loading" lines={3} />
        </aside>
      </div>
    </main>
  );
}
