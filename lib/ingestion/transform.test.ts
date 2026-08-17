import { describe, test, expect } from "bun:test";
import { validateInvoice } from "./transform";

describe("validateInvoice", () => {
  test("accepts a schema-drifted string amount", () => {
    const result = validateInvoice({
      external_id: "inv_00100",
      customer: "Aperture Capital",
      amount: "1234.56",
      currency: "USD",
      status: "open",
      issued_at: "2026-08-01",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.invoice.amount_cents).toBe(123456);
    }
  });

  test("rejects a null customer with a reason", () => {
    const result = validateInvoice({
      external_id: "inv_00001",
      customer: null,
      amount: 100,
      currency: "USD",
      status: "open",
      issued_at: "2026-08-01",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("customer");
    }
  });

  test("rejects a bad date format", () => {
    const result = validateInvoice({
      external_id: "inv_00002",
      customer: "Blue Harbor Advisors",
      amount: 100,
      currency: "USD",
      status: "open",
      issued_at: "08/01/2026",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("issued_at");
    }
  });
});
