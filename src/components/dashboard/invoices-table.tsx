import Link from "next/link";
import { formatMoney } from "@/features/dashboard/metrics";
import {
  encodeCursor,
  type InvoicePage,
  type QueryResult,
} from "@/features/dashboard/queries";
import { PanelSkeleton } from "@/components/ui/panel-skeleton";
import { EmptyState, Panel, PanelError } from "@/components/ui/status-badge";

// US-02. The invoice list, paged with a keyset cursor carried in the URL.
//
// Links rather than buttons: the cursor lives in the query string, so a page
// of results is addressable, survives a reload, and needs no client state.
// "Back" is the browser's, which is the behaviour a reader expects from a
// list anyway.

export function InvoicesTable({
  result,
  isLoading = false,
}: {
  result: QueryResult<InvoicePage>;
  isLoading?: boolean;
}) {
  if (isLoading) {
    return <PanelSkeleton label="Invoices loading" lines={5} />;
  }

  if (!result.ok) {
    return (
      <Panel title="Invoices" testId="invoices">
        <PanelError message={result.error} />
      </Panel>
    );
  }

  const { rows, nextCursor } = result.data;

  if (rows.length === 0) {
    return (
      <Panel title="Invoices" testId="invoices">
        <EmptyState>
          No invoices yet. Trigger an ingestion run and the invoices it writes
          will appear here, newest first.
        </EmptyState>
      </Panel>
    );
  }

  return (
    <Panel
      title="Invoices"
      testId="invoices"
      action={
        nextCursor && (
          <Link
            data-testid="invoices-next"
            href={`/dashboard?after=${encodeURIComponent(encodeCursor(nextCursor))}`}
            className="rounded-control text-xs font-medium text-primary outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Next page →
          </Link>
        )
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-faint">
              <th className="pb-tight font-medium">Invoice</th>
              <th className="pb-tight font-medium">Customer</th>
              <th className="pb-tight font-medium">Issued</th>
              <th className="pb-tight font-medium">Status</th>
              <th className="pb-tight text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody data-testid="invoice-rows">
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-border-subtle">
                <td className="py-tight font-mono text-xs text-muted-foreground">
                  {row.external_id}
                </td>
                <td className="py-tight text-foreground">{row.customer}</td>
                <td className="py-tight text-muted-foreground">
                  {row.issued_at.slice(0, 10)}
                </td>
                <td className="py-tight text-muted-foreground">{row.status}</td>
                <td className="py-tight text-right font-mono text-foreground">
                  {formatMoney(row.amount_cents, row.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
