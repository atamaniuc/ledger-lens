import { expect, test } from "@playwright/test";
import type { Citation } from "../lib/agent/citations";
import { ingest } from "./helpers/api";
import { signInBrowser } from "./helpers/auth";
import { ORG_A, sql } from "./helpers/db";
import { localStack } from "./helpers/stack";

// Stage 5, Batch J: the copilot panel, asserted in the browser.
//
// Most of these stub `/api/agent/chat` rather than calling it. That is the
// point: what the panel has to get right is how it presents an answer — a
// flagged citation stays visible, an abstention does not read as a failure, a
// cited invoice reaches the same lineage drawer a metric tile opens. Driving
// those states through a real model would make each one depend on that
// model's wording that day, and several of them (an invented citation) cannot
// be produced on demand at all.
//
// The route itself is covered by stage5-agent-route.spec.ts, the loop by
// stage5-agent-safety.spec.ts, and the whole path end to end by Batch K once
// an ANTHROPIC_API_KEY exists.

let apiUrl: string;
let invoiceExternalId: string;

const answer = (
  overrides: Partial<{
    answer: string;
    outcome: string;
    terminationReason: string | null;
    citations: Citation[];
    verified: boolean;
    toolsUsed: string[];
  }> = {},
) => ({
  correlation_id: "copilot-panel-test",
  answer: "Payment terms are Net 30.",
  outcome: "ok",
  terminationReason: null,
  steps: 2,
  toolsUsed: ["search_documents"],
  retrievedChunkIds: [1],
  citedInvoiceIds: [],
  citations: [] as Citation[],
  verified: true,
  usage: { inputTokens: 100, outputTokens: 50 },
  ...overrides,
});

test.beforeAll(async ({ request }) => {
  ({ apiUrl } = localStack());

  const [{ count }] = await sql<{ count: number }[]>`
    select count(*)::int from invoices where org_id = ${ORG_A}`;
  if (count === 0) await ingest(request, ORG_A);

  [{ external_id: invoiceExternalId }] = await sql<{ external_id: string }[]>`
    select external_id from invoices where org_id = ${ORG_A} order by id limit 1`;
});

test.describe("Stage 5 — the copilot panel", () => {
  test("sits in the dashboard's third column and will not send an empty question", async ({
    page,
    context,
    request,
  }) => {
    await signInBrowser(context, request, apiUrl, "alice@acme.test");
    await page.goto("/dashboard");

    await expect(page.getByTestId("copilot-slot").getByTestId("copilot")).toBeVisible();
    await expect(page.getByTestId("copilot-submit")).toBeDisabled();

    await page.getByTestId("copilot-question").fill("what are our payment terms?");
    await expect(page.getByTestId("copilot-submit")).toBeEnabled();
  });

  test("an unconfigured deployment says so, and the rest of the page still works", async ({
    page,
    context,
    request,
  }) => {
    await signInBrowser(context, request, apiUrl, "alice@acme.test");
    await page.route("**/api/agent/chat", (route) =>
      route.fulfill({
        status: 503,
        json: { error: "the copilot is not configured on this deployment" },
      }),
    );

    await page.goto("/dashboard");
    await page.getByTestId("copilot-question").fill("what are our payment terms?");
    await page.getByTestId("copilot-submit").click();

    await expect(page.getByTestId("copilot-unconfigured")).toContainText("not configured");
    // Not an error state: an operator's missing key must not be dressed up as
    // a failed question, and must not take the dashboard down with it.
    await expect(page.getByTestId("copilot-error")).toHaveCount(0);
    await expect(page.getByTestId("metric-revenue")).toBeVisible();
  });

  test("a cited invoice opens the same lineage drawer a metric tile opens", async ({
    page,
    context,
    request,
  }) => {
    await signInBrowser(context, request, apiUrl, "alice@acme.test");
    await page.route("**/api/agent/chat", (route) =>
      route.fulfill({
        json: answer({
          answer: `The oldest open one is [invoice:${invoiceExternalId}].`,
          citations: [{ kind: "invoice", id: invoiceExternalId, verified: true }],
        }),
      }),
    );

    await page.goto("/dashboard");
    await page.getByTestId("copilot-question").fill("which invoice is oldest?");
    await page.getByTestId("copilot-submit").click();

    const citation = page.getByTestId("copilot-citation");
    await expect(citation).toHaveAttribute("data-verified", "true");

    await citation.click();
    await expect(page.getByTestId("lineage")).toContainText(`Invoice ${invoiceExternalId}`);
    await expect(page.getByTestId("lineage-records")).toContainText(invoiceExternalId);
  });

  test("an invented citation is shown, flagged, and not quietly removed", async ({
    page,
    context,
    request,
  }) => {
    await signInBrowser(context, request, apiUrl, "alice@acme.test");
    await page.route("**/api/agent/chat", (route) =>
      route.fulfill({
        json: answer({
          answer: "Terms are Net 45 [invoice:inv_does_not_exist].",
          citations: [{ kind: "invoice", id: "inv_does_not_exist", verified: false }],
          verified: false,
        }),
      }),
    );

    await page.goto("/dashboard");
    await page.getByTestId("copilot-question").fill("what are our payment terms?");
    await page.getByTestId("copilot-submit").click();

    await expect(page.getByTestId("copilot-unverified")).toBeVisible();
    // Still there, and still readable — removing it would hide the one signal
    // that the sentence around it may be invented.
    await expect(page.getByTestId("copilot-answer")).toContainText("inv_does_not_exist");
    await expect(page.getByTestId("copilot-citation")).toHaveAttribute(
      "data-verified",
      "false",
    );

    // And following it does not open an empty drawer pretending to be lineage.
    await page.getByTestId("copilot-citation").click();
    await expect(page.getByTestId("copilot-cite-note")).toContainText("not an invoice you can see");
    await expect(page.getByTestId("lineage")).toHaveCount(0);
  });

  test("an abstention reads as an abstention, not as a failure", async ({
    page,
    context,
    request,
  }) => {
    await signInBrowser(context, request, apiUrl, "alice@acme.test");
    await page.route("**/api/agent/chat", (route) =>
      route.fulfill({
        json: answer({
          answer: "I don't have data on that.",
          outcome: "abstained",
          toolsUsed: ["search_documents"],
        }),
      }),
    );

    await page.goto("/dashboard");
    await page.getByTestId("copilot-question").fill("what is our parental leave policy?");
    await page.getByTestId("copilot-submit").click();

    await expect(page.getByTestId("copilot-outcome")).toContainText("found nothing relevant");
    await expect(page.getByTestId("copilot-answer")).toContainText("I don't have data on that");
    await expect(page.getByTestId("copilot-error")).toHaveCount(0);
  });

  test("a 200 that is not an answer fails the panel and not the page", async ({
    page,
    context,
    request,
  }) => {
    await signInBrowser(context, request, apiUrl, "alice@acme.test");
    await page.route("**/api/agent/chat", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<html>proxy</html>" }),
    );

    await page.goto("/dashboard");
    await page.getByTestId("copilot-question").fill("what are our payment terms?");
    await page.getByTestId("copilot-submit").click();

    await expect(page.getByTestId("copilot-error")).toBeVisible();
    // The point of the assertion: a throw inside render would unmount the
    // whole client tree, so the panel would take the dashboard with it.
    await expect(page.getByTestId("metric-revenue")).toBeVisible();
    await expect(page.getByTestId("invoices")).toBeVisible();
  });

  test("a failed turn shows its correlation_id", async ({ page, context, request }) => {
    await signInBrowser(context, request, apiUrl, "alice@acme.test");
    await page.route("**/api/agent/chat", (route) =>
      route.fulfill({
        status: 500,
        json: { error: "the copilot could not answer that", correlation_id: "abc-123" },
      }),
    );

    await page.goto("/dashboard");
    await page.getByTestId("copilot-question").fill("what are our payment terms?");
    await page.getByTestId("copilot-submit").click();

    // The one thing a reader can hand to whoever reads the logs.
    await expect(page.getByTestId("copilot-error")).toContainText("abc-123");
  });
});
