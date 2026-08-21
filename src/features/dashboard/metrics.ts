// The headline figures, derived from invoice rows. Pure, so the arithmetic is
// provable without a browser or a database — which matters more here than
// elsewhere, because the whole product claim is that these numbers are right.

/** Money is integer cents everywhere in this project. Never a float. */
export interface InvoiceAmount {
  amount_cents: number;
  currency: string;
}

export interface Metrics {
  invoiceCount: number;
  totalCents: number;
  /** `null` for an empty set — the caller renders "—" rather than NaN. */
  averageCents: number | null;
  /** The currency the figures are in, or `null` when there is nothing to show. */
  currency: string | null;
  /**
   * True when the rows carry more than one currency. Summing across them
   * would be arithmetic on incomparable units, so the caller has to say so
   * rather than print a number that means nothing.
   */
  mixedCurrency: boolean;
}

export function deriveMetrics(invoices: readonly InvoiceAmount[]): Metrics {
  if (invoices.length === 0) {
    return {
      invoiceCount: 0,
      totalCents: 0,
      averageCents: null,
      currency: null,
      mixedCurrency: false,
    };
  }

  let totalCents = 0;
  for (const invoice of invoices) totalCents += invoice.amount_cents;

  const currencies = new Set(invoices.map((i) => i.currency));

  return {
    invoiceCount: invoices.length,
    totalCents,
    // Integer division, rounded rather than truncated: the average is a
    // display figure, and the exact total is reported separately.
    averageCents: Math.round(totalCents / invoices.length),
    currency: currencies.size === 1 ? [...currencies][0] : null,
    mixedCurrency: currencies.size > 1,
  };
}

/**
 * Cents to a readable amount. `null` renders as an em dash — the empty state
 * the PRD asks for, and never `NaN` or `0` standing in for "no data".
 */
export function formatMoney(cents: number | null, currency: string | null): string {
  if (cents === null) return "—";

  const formatter = new Intl.NumberFormat("en-US", {
    style: currency ? "currency" : "decimal",
    currency: currency ?? undefined,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return formatter.format(cents / 100);
}
