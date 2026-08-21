// Captures the "before idempotency" reconciliation drift required by
// .claude/PRD.md's Data Quality & Reconciliation US-04, which specifies the
// number must be measured during Stage 2 — before idempotency lands — and
// then preserved as a fixed artifact rather than reproduced live in Stage 3.
//
// Measuring it does NOT mean weakening the shipped pipeline. CLAUDE.md
// forbids softening the mock provider's failure modes to make things pass,
// and idempotency is a P0 guarantee. What this script measures instead is
// the thing that guarantee prevents: what a naive consumer that reads the
// provider's stream and sums it without deduplicating would report, against
// the provider's own independent summary total.
//
// The provider's /summary endpoint always computes from the deduplicated
// dataset (it forces duplicates: false regardless of the flag on
// /invoices), so it is a genuinely independent source of truth — not our
// own derived data compared against itself.
//
// Usage: pnpm exec tsx scripts/capture-reconciliation-baseline.ts [baseUrl]

export {}; // top-level await needs this file to be a module

interface RawInvoice {
  external_id: string;
  amount: number | string;
}

const baseUrl = process.argv[2] ?? "http://localhost:3000";

function amountCents(invoice: RawInvoice): number {
  const n = typeof invoice.amount === "string" ? Number.parseFloat(invoice.amount) : invoice.amount;
  return Math.round(n * 100);
}

async function fetchAll(duplicates: boolean): Promise<RawInvoice[]> {
  const all: RawInvoice[] = [];
  let cursor: string | null = null;

  // Chaos flags that inject failures are disabled: this is a measurement of
  // duplicate-driven drift, and a 429 mid-walk would just add noise to it.
  // `duplicates` is the one variable under test.
  const flags = new URLSearchParams({
    duplicates: String(duplicates),
    rateLimit: "false",
    serverError: "false",
    expiredToken: "false",
  });

  for (;;) {
    const params = new URLSearchParams(flags);
    if (cursor) params.set("cursor", cursor);
    const res = await fetch(`${baseUrl}/api/mock-provider/invoices?${params}`);
    if (!res.ok) throw new Error(`provider returned ${res.status}`);
    const page = (await res.json()) as { data: RawInvoice[]; next_cursor: string | null };
    all.push(...page.data);
    if (page.next_cursor === null) break;
    cursor = page.next_cursor;
  }
  return all;
}

const summaryRes = await fetch(`${baseUrl}/api/mock-provider/summary`);
const summary = (await summaryRes.json()) as {
  total_amount_cents: number;
  invoice_count: number;
};

const withDuplicates = await fetchAll(true);
const deduplicated = await fetchAll(false);

// What a non-deduplicating consumer would sum.
const naiveTotal = withDuplicates.reduce((sum, inv) => sum + amountCents(inv), 0);

// What the shipped pipeline sums: raw_events' unique constraint collapses
// repeats, so each external_id contributes exactly once.
const uniqueByExternalId = new Map<string, RawInvoice>();
for (const inv of withDuplicates) uniqueByExternalId.set(inv.external_id, inv);
const idempotentTotal = [...uniqueByExternalId.values()].reduce(
  (sum, inv) => sum + amountCents(inv),
  0,
);

const driftCents = naiveTotal - summary.total_amount_cents;
const driftPct = (driftCents / summary.total_amount_cents) * 100;
const idempotentDriftCents = idempotentTotal - summary.total_amount_cents;

console.log(
  JSON.stringify(
    {
      captured_at: new Date().toISOString(),
      provider_summary: {
        total_amount_cents: summary.total_amount_cents,
        invoice_count: summary.invoice_count,
      },
      stream: {
        records_with_duplicates: withDuplicates.length,
        records_deduplicated: deduplicated.length,
        duplicate_records: withDuplicates.length - deduplicated.length,
      },
      before_idempotency: {
        total_amount_cents: naiveTotal,
        drift_cents: driftCents,
        drift_pct: Number(driftPct.toFixed(3)),
      },
      after_idempotency: {
        total_amount_cents: idempotentTotal,
        drift_cents: idempotentDriftCents,
        drift_pct: Number(((idempotentDriftCents / summary.total_amount_cents) * 100).toFixed(3)),
      },
    },
    null,
    2,
  ),
);
