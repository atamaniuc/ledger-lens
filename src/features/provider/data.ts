import { mulberry32 } from "./prng";
import type { ChaosFlags } from "./chaos";

export interface RawInvoice {
  external_id: string;
  customer: string | null;
  amount: number | string;
  currency: "USD";
  status: "draft" | "open" | "paid" | "void";
  issued_at: string; // YYYY-MM-DD
}

const TOTAL_INVOICES = 200;
// Invoices at/after this index get the schemaDrift treatment (amount
// becomes a numeric string instead of a number) — simulates a provider
// changing its API mid-stream, not from the very first record.
const SCHEMA_DRIFT_INDEX = 100;
const DEFAULT_SEED = Number(process.env.MOCK_PROVIDER_SEED ?? 42);

const CUSTOMERS = [
  "Aperture Capital",
  "Blue Harbor Advisors",
  "Cedar Ridge Partners",
  "Delta Point Ventures",
  "Elm & Vine Holdings",
  "Fulcrum Asset Group",
];
const STATUSES = ["draft", "open", "paid", "void"] as const;

type DataFlags = Pick<ChaosFlags, "duplicates" | "schemaDrift" | "nullFields" | "futureDates">;

function buildInvoice(index: number, rand: () => number, flags: DataFlags): RawInvoice {
  const amount = Math.round((5 + rand() * 5000) * 100) / 100;
  // Every draw is consumed unconditionally, and the flag gates only whether
  // its *result* is applied. Short-circuiting (`flags.nullFields && rand() <
  // 0.08`) skips the draw when the flag is off, which shifts the PRNG stream
  // for every record after it — so the same seed produced different amounts
  // depending on which flags were set. That broke two things at once: the
  // PRD's "deterministic under a fixed seed" claim for this stage, and Stage
  // 3's reconciliation, which compares the ingested total against /summary
  // (computed with duplicates forced off). With the streams diverging,
  // reconciliation drift could never reach zero no matter how correct the
  // pipeline was.
  const nullRoll = rand();
  const futureRoll = rand();
  const drifted = flags.schemaDrift && index >= SCHEMA_DRIFT_INDEX;
  const nulled = flags.nullFields && nullRoll < 0.08;
  const future = flags.futureDates && futureRoll < 0.03;

  const issuedDate = new Date();
  const offsetDays = future ? -Math.floor(1 + rand() * 30) : Math.floor(rand() * 180);
  issuedDate.setUTCDate(issuedDate.getUTCDate() - offsetDays);

  return {
    external_id: `inv_${String(index).padStart(5, "0")}`,
    customer: nulled ? null : CUSTOMERS[index % CUSTOMERS.length],
    amount: drifted ? amount.toFixed(2) : amount,
    currency: "USD",
    status: STATUSES[index % STATUSES.length],
    issued_at: issuedDate.toISOString().slice(0, 10),
  };
}

// Deterministic under `seed` — same seed always produces the same base
// sequence, so a fixed seed doubles as a regression fixture, not just a
// demo toy (.claude/PRD.md "Mock Provider" North Star metric).
export function generateDataset(flags: DataFlags, seed: number = DEFAULT_SEED): RawInvoice[] {
  const rand = mulberry32(seed);
  const invoices: RawInvoice[] = [];

  for (let i = 0; i < TOTAL_INVOICES; i++) {
    const invoice = buildInvoice(i, rand, flags);
    invoices.push(invoice);

    // ~5% repeat rate: reinsert the record just produced. This is what
    // makes the reconciliation-drift demo (Stage 3) possible — a naive
    // consumer that doesn't dedupe will overstate its total.
    //
    // Draw first, then check the flag — same reason as in buildInvoice: a
    // short-circuited draw desynchronizes the stream for every later record.
    const duplicateRoll = rand();
    if (flags.duplicates && duplicateRoll < 0.05) {
      invoices.push({ ...invoice });
    }
  }

  return invoices;
}

export function invoiceAmountAsNumber(invoice: RawInvoice): number {
  return typeof invoice.amount === "string" ? parseFloat(invoice.amount) : invoice.amount;
}
