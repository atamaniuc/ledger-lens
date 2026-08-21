// Generates golden fixtures for the Python chunker parity tests.
// Runs the REAL TypeScript chunker (src/features/rag/chunk.ts) over representative
// texts and invoices, and writes golden_chunks.json + golden_invoices.json
// next to this file. The pytest suite asserts the Python port reproduces
// these byte for byte.
//
// Usage (from the repo root): pnpm exec tsx py/tests/fixtures/generate_golden.ts
// tsx resolves the extensionless import; the file is excluded from the app's
// typecheck (py/ is not part of the Next.js app), so it must run standalone.

import { chunkText, hashText, renderInvoice, splitIntoChunks } from "../../../src/features/rag/chunk";
import { writeFileSync } from "node:fs";

const sentence = (n: number) => `Sentence number ${n} says something about invoices and terms.`;
const paragraph = (count: number) =>
  Array.from({ length: count }, (_, i) => sentence(i)).join(" ");

const chunkCases = [
  { id: "short", text: "Net 30 from the invoice date.", opts: undefined },
  { id: "paragraph-40", text: paragraph(40), opts: undefined },
  {
    id: "tricky-punct",
    text:
      "Invoices are issued on Net 30 terms. Unpaid invoices accrue interest at 1.5 percent per month. " +
      "Escalate to collections after 60 days. Contact a.brown@example.com or ext. 4021 for exceptions!? " +
      "Reference numbers look like INV-1.2 and must not be split.",
    opts: undefined,
  },
  {
    id: "whitespace-noise",
    text: paragraph(10).replace(/ /g, "  ").replace(/\./g, ".\n"),
    opts: undefined,
  },
  {
    id: "long-sentence-hardcut",
    text: "x".repeat(2500),
    opts: { maxChars: 900, overlapChars: 100 },
  },
  {
    id: "overlap-fills-chunk",
    text: paragraph(20),
    opts: { maxChars: 120, overlapChars: 110 },
  },
  {
    id: "unicode-emoji",
    text:
      "Invoice for ☕ and 🚀 launch on 2026-03-01. Amount 99.99 USD. " +
      "Café résumé naïveté — great!? 🎉 Done. Follow-up at ext. 4021.",
    opts: undefined,
  },
  {
    id: "single-huge-sentence",
    text:
      "The late payment policy is simple: every invoice that remains unpaid more than ninety days from " +
      "its issue date is automatically escalated to the collections team, which contacts the customer " +
      "in writing, by phone, and by electronic mail before any further action is taken, and this " +
      "entire escalation sequence is documented in the internal ledger for audit purposes by the " +
      "accounts receivable department.",
    opts: undefined,
  },
  { id: "invoice-memo", text: paragraph(15), opts: undefined },
  { id: "empty", text: "", opts: undefined },
  { id: "whitespace-only", text: "  \n\t ", opts: undefined },
  { id: "terminators-run", text: "What!? Really?! Yes. No way!! Maybe...", opts: undefined },
  {
    id: "decimal-heavy",
    text: "Interest is 1.5 percent monthly. Total 1,234.56 USD. Rate 3.75% APR. Score 0.999 was reported. Version 2.0.1 shipped.",
    opts: undefined,
  },
];

const invoiceCases = [
  {
    id: "open-usd",
    invoice: {
      external_id: "INV-2043",
      customer: "Northwind Traders",
      amount_cents: 120000,
      currency: "usd",
      status: "open",
      issued_at: "2026-03-01",
      paid_at: null,
    },
  },
  {
    id: "paid-with-date",
    invoice: {
      external_id: "INV-00007",
      customer: "Globex Inc",
      amount_cents: 350050,
      currency: "EUR",
      status: "paid",
      issued_at: "2026-02-14",
      paid_at: "2026-03-20",
    },
  },
  {
    id: "paid-no-date",
    invoice: {
      external_id: "INV-99",
      customer: "Acme Corp",
      amount_cents: 5,
      currency: "usd",
      status: "paid",
      issued_at: "2026-03-01",
      paid_at: null,
    },
  },
  {
    id: "draft-small",
    invoice: {
      external_id: "INV-1",
      customer: "Acme Corp",
      amount_cents: 99,
      currency: "usd",
      status: "draft",
      issued_at: "2026-04-01",
      paid_at: null,
    },
  },
  {
    id: "large-void",
    invoice: {
      external_id: "INV-888888",
      customer: "Northwind Traders",
      amount_cents: 123456789,
      currency: "Usd",
      status: "void",
      issued_at: "2026-05-05",
      paid_at: null,
    },
  },
  {
    id: "quote",
    invoice: {
      external_id: "INV-1.2",
      customer: "Bob's Diner",
      amount_cents: 100005,
      currency: "gbp",
      status: "open",
      issued_at: "2026-06-01",
      paid_at: null,
    },
  },
];

async function main() {
  const chunkFixtures = [];
  for (const c of chunkCases) {
    const opts = c.opts ?? {};
    const chunks = splitIntoChunks(c.text, opts);
    const hashed = await chunkText(c.text, opts);
    chunkFixtures.push({
      id: c.id,
      text: c.text,
      opts: c.opts ?? null,
      chunks,
      hashes: hashed.map((h) => h.content_hash),
    });
  }
  writeFileSync(new URL("./golden_chunks.json", import.meta.url), JSON.stringify(chunkFixtures, null, 2) + "\n");

  const invoiceFixtures = [];
  for (const c of invoiceCases) {
    const rendered = renderInvoice(c.invoice);
    invoiceFixtures.push({
      id: c.id,
      invoice: c.invoice,
      rendered,
      hash: await hashText(rendered),
    });
  }
  writeFileSync(new URL("./golden_invoices.json", import.meta.url), JSON.stringify(invoiceFixtures, null, 2) + "\n");
  console.log(`wrote ${chunkFixtures.length} chunk fixtures, ${invoiceFixtures.length} invoice fixtures`);
}

main();