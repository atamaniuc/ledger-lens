import { describe, test, expect } from "vitest";
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

  // D-15: `futureDates` chaos flows through the format-only Zod check as a
  // valid invoice unless the transform quarantines it. The rule must be a
  // regression test, not a comment.
  test("quarantines an invoice dated after today with a future_dated reason", () => {
    const result = validateInvoice(
      {
        external_id: "inv_00003",
        customer: "Aperture Capital",
        amount: 100,
        currency: "USD",
        status: "open",
        issued_at: "2026-09-01",
      },
      { today: new Date("2026-08-21T12:00:00Z") },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("future_dated");
      expect(result.reason).toContain("2026-09-01");
      expect(result.reason).toContain("2026-08-21");
    }
  });

  test("accepts an invoice dated today (today is not future)", () => {
    const result = validateInvoice(
      {
        external_id: "inv_00004",
        customer: "Aperture Capital",
        amount: 100,
        currency: "USD",
        status: "open",
        issued_at: "2026-08-21",
      },
      { today: new Date("2026-08-21T23:59:00Z") },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.invoice.issued_at).toBe("2026-08-21");
    }
  });

  test("accepts a past-dated invoice", () => {
    const result = validateInvoice(
      {
        external_id: "inv_00005",
        customer: "Aperture Capital",
        amount: 100,
        currency: "USD",
        status: "open",
        issued_at: "2026-08-01",
      },
      { today: new Date("2026-08-21T12:00:00Z") },
    );

    expect(result.ok).toBe(true);
  });

  test("defaults to the current date when no today is injected", () => {
    const result = validateInvoice({
      external_id: "inv_00006",
      customer: "Aperture Capital",
      amount: 100,
      currency: "USD",
      status: "open",
      // A year out is future under any real clock.
      issued_at: "2099-01-01",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("future_dated");
    }
  });
});
