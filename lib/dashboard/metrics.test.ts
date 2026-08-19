import { describe, expect, it } from "bun:test";
import { deriveMetrics, formatMoney } from "./metrics";

const usd = (amount_cents: number) => ({ amount_cents, currency: "USD" });

describe("deriveMetrics", () => {
  it("sums and averages in integer cents", () => {
    const m = deriveMetrics([usd(100_00), usd(50_00), usd(25_00)]);
    expect(m.invoiceCount).toBe(3);
    expect(m.totalCents).toBe(175_00);
    expect(m.averageCents).toBe(5833);
  });

  it("returns null rather than NaN over an empty set", () => {
    // 0/0 is the bug this exists to prevent: an average of NaN renders as
    // "NaN" on a page whose entire claim is that the numbers are right.
    const m = deriveMetrics([]);
    expect(m.averageCents).toBeNull();
    expect(m.totalCents).toBe(0);
    expect(m.invoiceCount).toBe(0);
  });

  it("flags mixed currencies instead of summing across them", () => {
    const m = deriveMetrics([usd(100_00), { amount_cents: 100_00, currency: "EUR" }]);
    expect(m.mixedCurrency).toBe(true);
    expect(m.currency).toBeNull();
  });

  it("does not lose precision on values a float would round", () => {
    // Integer cents, so this is exact. The same sum in floating-point
    // dollars is not.
    const m = deriveMetrics([usd(1), usd(2), usd(3), usd(4), usd(5), usd(6), usd(7)]);
    expect(m.totalCents).toBe(28);
  });
});

describe("formatMoney", () => {
  it("renders an em dash for no data", () => {
    expect(formatMoney(null, "USD")).toBe("—");
  });

  it("renders zero as zero, not as absent", () => {
    // A real total of 0 and "we do not know" are different facts.
    expect(formatMoney(0, "USD")).toBe("$0.00");
  });

  it("formats cents as a currency amount", () => {
    expect(formatMoney(47_942_632_00, "USD")).toBe("$47,942,632.00");
  });

  it("falls back to a plain number when the currency is ambiguous", () => {
    expect(formatMoney(12_34, null)).toBe("12.34");
  });
});
