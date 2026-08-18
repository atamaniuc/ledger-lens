import { expect, test } from "@playwright/test";
import { flagsOffExcept, type ProviderPage, type ProviderSummary } from "./helpers/api";

// Stage 1: a deliberately adversarial upstream. Each chaos flag is asserted
// in isolation — every other flag off — so a failure names one failure mode
// rather than "something in the provider".

test.describe("Stage 1 — Mock Provider", () => {
  let summary: ProviderSummary;

  test("summary reports a total and a count", async ({ request }) => {
    const res = await request.get("/api/mock-provider/summary");
    expect(res.status()).toBe(200);
    summary = await res.json();
    expect(summary.total_amount_cents).toBeGreaterThan(0);
    expect(summary.invoice_count).toBeGreaterThan(0);
  });

  test("a page comes back well-formed", async ({ request }) => {
    const res = await request.get("/api/mock-provider/invoices", { params: flagsOffExcept() });
    expect(res.status()).toBe(200);
    const page: ProviderPage = await res.json();
    expect(page.data.length).toBeGreaterThan(0);
    for (const record of page.data) {
      expect(record.external_id, JSON.stringify(record)).toEqual(expect.any(String));
    }
    expect(page.next_cursor === null || typeof page.next_cursor === "string").toBe(true);
  });

  test("the cursor walks the whole dataset and stops", async ({ request }) => {
    let cursor: string | null = null;
    let pages = 0;
    const seen: string[] = [];

    while (pages < 50) {
      const params: Record<string, string> = flagsOffExcept();
      if (cursor) params.cursor = cursor;
      const res = await request.get("/api/mock-provider/invoices", { params });
      // A failed request must fail the test rather than break the loop: an
      // error on the first page leaves the cursor untouched, which is
      // indistinguishable from a clean walk to the end.
      expect(res.status(), `page ${pages + 1}`).toBe(200);
      const page: ProviderPage = await res.json();
      seen.push(...page.data.map((r) => r.external_id));
      pages++;
      cursor = page.next_cursor;
      if (cursor === null) break;
    }

    expect(cursor, "still had a cursor after 50 pages").toBeNull();
    expect(pages).toBeGreaterThan(0);
    // The strong assertion: the deduplicated stream reconciles exactly
    // against the provider's own independent count. Any silent drop or
    // duplicate breaks this equality.
    expect(seen.length).toBe(summary.invoice_count);
  });

  test("schemaDrift starts emitting amount as a string mid-stream", async ({ request }) => {
    const res = await request.get("/api/mock-provider/invoices", {
      params: { ...flagsOffExcept("schemaDrift"), schemaDrift: "true", cursor: "100" },
    });
    expect(res.status()).toBe(200);
    const page: ProviderPage = await res.json();
    const drifted = page.data.filter((r) => typeof r.amount === "string");
    expect(drifted.length, "string-typed amounts on this page").toBeGreaterThan(0);
  });

  test("rateLimit returns 429 with Retry-After", async ({ request }) => {
    // Fires on every 10th request, so ten attempts must produce one.
    for (let i = 1; i <= 10; i++) {
      const res = await request.get("/api/mock-provider/invoices", {
        params: { ...flagsOffExcept("rateLimit"), rateLimit: "true" },
      });
      if (res.status() === 429) {
        // The header is the point: a client that ignores it and hammers is
        // the failure this flag exists to catch.
        expect(res.headers()["retry-after"]).toBeTruthy();
        return;
      }
    }
    throw new Error("no 429 in 10 requests");
  });

  test("serverError returns 500", async ({ request }) => {
    // Fires on every 25th request.
    for (let i = 1; i <= 25; i++) {
      const res = await request.get("/api/mock-provider/invoices", {
        params: { ...flagsOffExcept("serverError"), serverError: "true" },
      });
      if (res.status() === 500) return;
    }
    throw new Error("no 500 in 25 requests");
  });

  test("expiredToken rejects a token after 15 requests", async ({ request }) => {
    // Counted per token string, so one token is used for the whole loop —
    // a fresh one each iteration would reset the count.
    const token = `playwright-${Date.now()}`;
    for (let i = 1; i <= 17; i++) {
      const res = await request.get("/api/mock-provider/invoices", {
        params: { ...flagsOffExcept("expiredToken"), expiredToken: "true" },
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.status() === 401) {
        expect(i, "token died before its 15-request budget").toBeGreaterThan(15);
        return;
      }
    }
    throw new Error("no 401 in 17 requests");
  });
});
