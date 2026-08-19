import { formatMoney, type Metrics } from "@/lib/dashboard/metrics";
import type { LineagePayload, QueryResult } from "@/lib/dashboard/queries";
import { PanelError } from "@/components/ui/status-badge";
import { SelectTrigger } from "./selection-context";

// US-02. The three headline figures.
//
// A Server Component: the numbers are in the first paint, not behind a
// spinner, because the PRD's North Star is someone looking at this page and
// deciding whether to believe it. Each tile wraps its figure in the smallest
// possible client island so clicking it can open lineage — the tile itself
// never becomes a client component.

const TILE =
  "flex w-full flex-col items-start gap-tight rounded-panel border border-border-subtle bg-surface p-section text-left " +
  "transition-colors hover:border-border-strong data-[selected]:border-accent data-[selected]:bg-accent";

export function MetricTiles({
  result,
  lineage,
}: {
  result: QueryResult<Metrics>;
  /** Computed during the server render, so selecting costs no round trip. */
  lineage: LineagePayload;
}) {
  if (!result.ok) return <PanelError message={result.error} />;

  const { invoiceCount, totalCents, averageCents, currency, mixedCurrency } =
    result.data;

  const tiles = [
    {
      key: "revenue",
      label: "Total invoiced",
      value: formatMoney(invoiceCount === 0 ? null : totalCents, currency),
    },
    { key: "count", label: "Invoices", value: String(invoiceCount) },
    {
      key: "average",
      label: "Average invoice",
      value: formatMoney(averageCents, currency),
    },
  ];

  return (
    <div data-testid="metric-tiles" className="grid gap-gutter sm:grid-cols-3">
      {tiles.map((tile) => (
        <SelectTrigger
          key={tile.key}
          label={tile.label}
          lineage={lineage}
          className={TILE}
        >
          <span className="text-xs font-medium uppercase tracking-wide text-faint">
            {tile.label}
          </span>
          <span
            data-testid={`metric-${tile.key}`}
            className="font-mono text-2xl font-semibold text-foreground"
          >
            {tile.value}
          </span>
        </SelectTrigger>
      ))}

      {mixedCurrency && (
        <p
          role="alert"
          data-testid="mixed-currency"
          className="text-xs text-status-warn sm:col-span-3"
        >
          These invoices span more than one currency. The total is not shown,
          because adding across currencies would produce a number that means
          nothing.
        </p>
      )}
    </div>
  );
}
