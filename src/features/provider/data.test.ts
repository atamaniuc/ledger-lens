import { describe, test, expect } from "vitest";
import { generateDataset, invoiceAmountAsNumber, type RawInvoice } from "./data";

const ALL_ON = {
  duplicates: true,
  schemaDrift: true,
  nullFields: true,
  futureDates: true,
};

function amountsByExternalId(records: RawInvoice[]): Map<string, number> {
  const byId = new Map<string, number>();
  for (const record of records) byId.set(record.external_id, invoiceAmountAsNumber(record));
  return byId;
}

describe("generateDataset determinism", () => {
  test("same seed and flags produce an identical dataset", () => {
    const a = generateDataset(ALL_ON, 42);
    const b = generateDataset(ALL_ON, 42);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("a flag changes which failures are injected, never a record's amount", () => {
    // The regression this exists for. The flags were originally checked with
    // short-circuit `&&` before their random draw, so turning one off skipped
    // the draw and shifted the PRNG stream — the same external_id came back
    // with a different amount depending on which flags were set.
    //
    // Stage 3's reconciliation compares the ingested total against
    // /api/mock-provider/summary, which always computes with duplicates
    // forced off. If that flag can change amounts, reconciliation drift can
    // never reach zero regardless of how correct the pipeline is, and the
    // project's headline before/after artifact is impossible.
    const withDuplicates = amountsByExternalId(generateDataset(ALL_ON, 42));
    const withoutDuplicates = amountsByExternalId(
      generateDataset({ ...ALL_ON, duplicates: false }, 42),
    );

    expect(withoutDuplicates.size).toBe(withDuplicates.size);
    for (const [externalId, amount] of withDuplicates) {
      expect(withoutDuplicates.get(externalId)).toBe(amount);
    }
  });

  test("every flag combination agrees on amounts for a given seed", () => {
    const baseline = amountsByExternalId(generateDataset(ALL_ON, 7));
    const combinations = [
      { ...ALL_ON, nullFields: false },
      { ...ALL_ON, futureDates: false },
      { ...ALL_ON, duplicates: false, nullFields: false },
      { duplicates: false, schemaDrift: false, nullFields: false, futureDates: false },
    ];

    for (const flags of combinations) {
      const amounts = amountsByExternalId(generateDataset(flags, 7));
      for (const [externalId, amount] of baseline) {
        expect(amounts.get(externalId)).toBe(amount);
      }
    }
  });

  test("duplicates flag still actually injects duplicates", () => {
    // Determinism must not be bought by neutering the failure mode —
    // CLAUDE.md forbids softening the mock provider's chaos to make the
    // pipeline pass.
    const withDuplicates = generateDataset(ALL_ON, 42);
    const withoutDuplicates = generateDataset({ ...ALL_ON, duplicates: false }, 42);
    expect(withDuplicates.length).toBeGreaterThan(withoutDuplicates.length);
  });

  test("schemaDrift still switches amount to a string mid-stream", () => {
    const records = generateDataset({ ...ALL_ON, duplicates: false }, 42);
    const stringAmounts = records.filter((r) => typeof r.amount === "string").length;
    const numberAmounts = records.filter((r) => typeof r.amount === "number").length;
    expect(stringAmounts).toBe(100);
    expect(numberAmounts).toBe(100);
  });

  test("nullFields still produces null customers", () => {
    const records = generateDataset(ALL_ON, 42);
    expect(records.some((r) => r.customer === null)).toBe(true);
  });
});
