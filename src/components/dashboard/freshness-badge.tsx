import type { Freshness } from "@/features/dashboard/freshness";
import { formatAge } from "@/features/dashboard/freshness";
import type { QueryResult } from "@/features/dashboard/queries";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";

// US-03. How old the data is, said plainly.
//
// There is no code path here that renders "fresh" without a timestamp that
// actually is. A failed query renders `unknown`; an org with no rows renders
// `no data`, which is not the same as stale.

export function FreshnessBadge({
  result,
  isLoading = false,
}: {
  result: QueryResult<Freshness>;
  isLoading?: boolean;
}) {
  if (isLoading) {
    return (
      <span data-testid="freshness" aria-busy="true">
        <Skeleton className="h-5 w-36 rounded-control" />
      </span>
    );
  }

  if (!result.ok) {
    return (
      <span data-testid="freshness" title={result.error}>
        <StatusBadge state="unknown" label="Freshness unknown" />
      </span>
    );
  }

  const freshness = result.data;

  if (freshness.state === "empty") {
    return (
      <span data-testid="freshness">
        <StatusBadge state="missing" label="No data yet" />
      </span>
    );
  }

  if (freshness.state === "unknown") {
    return (
      <span data-testid="freshness">
        <StatusBadge state="unknown" label="Freshness unknown" />
      </span>
    );
  }

  const age = formatAge(freshness.ageMs);
  return (
    <span
      data-testid="freshness"
      title={freshness.ingestedAt.toISOString()}
      data-freshness={freshness.state}
    >
      <StatusBadge
        state={freshness.state === "fresh" ? "pass" : "warn"}
        label={freshness.state === "fresh" ? `Fresh · ${age}` : `Stale · ${age}`}
      />
    </span>
  );
}
