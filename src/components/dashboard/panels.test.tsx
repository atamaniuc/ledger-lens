import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { Providers } from "@/components/providers";
import { DataHealthPanel } from "./data-health-panel";
import { FreshnessBadge } from "./freshness-badge";
import { InvoicesTable } from "./invoices-table";
import { LineagePanel } from "./lineage-drill-down";
import { MetricTiles } from "./metric-tiles";
import { PipelineStatusLive } from "./pipeline-status-live";
import { CopilotPanel } from "./copilot-panel";
import {
  AGENT_ANSWER,
  FRESHNESS_EMPTY,
  FRESHNESS_FRESH,
  FRESHNESS_STALE,
  FRESHNESS_UNKNOWN,
  HEALTH_DEFAULT,
  HEALTH_EMPTY,
  INVOICES_DEFAULT,
  INVOICES_EMPTY,
  LINEAGE_RECORDS,
  LINEAGE_SELECTION,
  METRICS_DEFAULT,
  METRICS_EMPTY,
  METRICS_MIXED_CURRENCY,
  RECENT_RUNS,
  errorResult,
  okResult,
} from "./panel-fixtures";

// Browser-mode component tests (vitest project "components"): the dashboard
// panels in every state, with an axe assertion on each state — AC-02. The
// stories render the same fixtures, so what the story documents and what the
// test asserts cannot drift apart.

async function expectNoViolations(container: HTMLElement) {
  const results = await axe.run(container);
  expect(
    results.violations.map((violation) => violation.id),
    JSON.stringify(
      results.violations.map((violation) => ({
        id: violation.id,
        help: violation.help,
        targets: violation.nodes.map((node) => node.target),
      })),
      null,
      2,
    ),
  ).toEqual([]);
}

function renderPanel(node: ReactNode) {
  return render(<Providers>{node}</Providers>);
}

describe("DataHealthPanel", () => {
  it("renders all four checks with a verdict, and passes axe", async () => {
    const { container } = renderPanel(<DataHealthPanel result={okResult(HEALTH_DEFAULT)} />);
    expect(screen.getByTestId("check-freshness")).toBeTruthy();
    expect(screen.getByTestId("check-volume")).toBeTruthy();
    expect(screen.getByTestId("check-uniqueness")).toBeTruthy();
    expect(screen.getByTestId("check-reconciliation")).toBeTruthy();
    // The verdict badge and the failing check badge both say "Fail".
    expect(screen.getAllByText("Fail").length).toBeGreaterThan(0);
    await expectNoViolations(container);
  });

  it("shows a panel-shaped skeleton while loading, and passes axe", async () => {
    const { container } = renderPanel(
      <DataHealthPanel result={okResult(HEALTH_DEFAULT)} isLoading />,
    );
    const skeleton = screen.getByTestId("panel-skeleton");
    expect(skeleton.getAttribute("aria-busy")).toBe("true");
    await expectNoViolations(container);
  });

  it("names the next action when nothing has run, and passes axe", async () => {
    const { container } = renderPanel(<DataHealthPanel result={okResult(HEALTH_EMPTY)} />);
    expect(screen.getByText(/Trigger an ingestion run/)).toBeTruthy();
    await expectNoViolations(container);
  });

  it("names what failed and offers a retry, and passes axe", async () => {
    const { container } = renderPanel(
      <DataHealthPanel result={errorResult("connection reset by the database")} />,
    );
    expect(screen.getByTestId("panel-error").textContent).toContain("connection reset");
    expect(screen.getByTestId("panel-retry")).toBeTruthy();
    await expectNoViolations(container);
  });
});

describe("InvoicesTable", () => {
  it("renders the rows and the next-page link, and passes axe", async () => {
    const { container } = renderPanel(<InvoicesTable result={okResult(INVOICES_DEFAULT)} />);
    const rows = screen.getByTestId("invoice-rows");
    expect(rows.querySelectorAll("tr").length).toBe(3);
    expect(screen.getByTestId("invoices-next")).toBeTruthy();
    await expectNoViolations(container);
  });

  it("shows a skeleton while loading, and passes axe", async () => {
    const { container } = renderPanel(
      <InvoicesTable result={okResult(INVOICES_DEFAULT)} isLoading />,
    );
    expect(screen.getByTestId("panel-skeleton")).toBeTruthy();
    await expectNoViolations(container);
  });

  it("says what to do when there are no invoices, and passes axe", async () => {
    const { container } = renderPanel(<InvoicesTable result={okResult(INVOICES_EMPTY)} />);
    expect(screen.getByText(/Trigger an ingestion run/)).toBeTruthy();
    await expectNoViolations(container);
  });

  it("offers a retry on error, and passes axe", async () => {
    const { container } = renderPanel(
      <InvoicesTable result={errorResult("relation invoices does not exist")} />,
    );
    expect(screen.getByTestId("panel-retry")).toBeTruthy();
    await expectNoViolations(container);
  });
});

describe("MetricTiles", () => {
  it("renders the three figures, and passes axe", async () => {
    const { container } = renderPanel(
      <MetricTiles result={okResult(METRICS_DEFAULT)} lineage={LINEAGE_SELECTION.lineage} />,
    );
    expect(screen.getByTestId("metric-revenue").textContent).toContain("$");
    expect(screen.getByTestId("metric-count").textContent).toBe("245");
    await expectNoViolations(container);
  });

  it("shows a skeleton while loading, and passes axe", async () => {
    const { container } = renderPanel(
      <MetricTiles result={okResult(METRICS_DEFAULT)} lineage={LINEAGE_SELECTION.lineage} isLoading />,
    );
    expect(container.querySelectorAll("[data-slot=skeleton]").length).toBe(3);
    await expectNoViolations(container);
  });

  it("warns instead of summing mixed currencies, and passes axe", async () => {
    const { container } = renderPanel(
      <MetricTiles result={okResult(METRICS_MIXED_CURRENCY)} lineage={LINEAGE_SELECTION.lineage} />,
    );
    expect(screen.getByTestId("mixed-currency")).toBeTruthy();
    await expectNoViolations(container);
  });

  it("renders an em dash instead of a number when empty, and passes axe", async () => {
    const { container } = renderPanel(
      <MetricTiles result={okResult(METRICS_EMPTY)} lineage={LINEAGE_SELECTION.lineage} />,
    );
    expect(screen.getByTestId("metric-revenue").textContent).toBe("—");
    await expectNoViolations(container);
  });
});

describe("PipelineStatusLive", () => {
  it("lists the runs and says it is connecting, and passes axe", async () => {
    const { container } = renderPanel(<PipelineStatusLive runs={RECENT_RUNS} />);
    expect(screen.getByTestId("run-rows").querySelectorAll("li").length).toBe(3);
    expect(screen.getByText("Connecting…")).toBeTruthy();
    await expectNoViolations(container);
  });

  it("shows a skeleton while loading, and passes axe", async () => {
    const { container } = renderPanel(<PipelineStatusLive runs={RECENT_RUNS} isLoading />);
    expect(screen.getByTestId("panel-skeleton")).toBeTruthy();
    await expectNoViolations(container);
  });

  it("says what to do with no runs, and passes axe", async () => {
    const { container } = renderPanel(<PipelineStatusLive runs={[]} />);
    expect(screen.getByText(/Trigger an ingestion run/)).toBeTruthy();
    await expectNoViolations(container);
  });

  it("offers a retry on error, and passes axe", async () => {
    const { container } = renderPanel(
      <PipelineStatusLive runs={[]} error="connection reset by the database" />,
    );
    expect(screen.getByTestId("panel-error")).toBeTruthy();
    expect(screen.getByTestId("panel-retry")).toBeTruthy();
    await expectNoViolations(container);
  });
});

describe("FreshnessBadge", () => {
  it("renders fresh and stale without ever inventing a timestamp", async () => {
    const fresh = render(<FreshnessBadge result={okResult(FRESHNESS_FRESH)} />);
    expect(screen.getByText(/Fresh/)).toBeTruthy();
    await expectNoViolations(fresh.container);
    fresh.unmount();
    const stale = render(<FreshnessBadge result={okResult(FRESHNESS_STALE)} />);
    expect(screen.getByText(/Stale/)).toBeTruthy();
    await expectNoViolations(stale.container);
  });

  it("distinguishes no-data from unknown from error", async () => {
    const noData = render(<FreshnessBadge result={okResult(FRESHNESS_EMPTY)} />);
    expect(screen.getByText("No data yet")).toBeTruthy();
    noData.unmount();
    const unknown = render(<FreshnessBadge result={okResult(FRESHNESS_UNKNOWN)} />);
    expect(screen.getByText("Freshness unknown")).toBeTruthy();
    unknown.unmount();
    const error = render(<FreshnessBadge result={errorResult("connection reset")} />);
    expect(screen.getByText("Freshness unknown")).toBeTruthy();
    await expectNoViolations(error.container);
  });
});

describe("LineagePanel", () => {
  it("renders the records, moves focus to Close, and passes axe", async () => {
    const { container } = renderPanel(
      <LineagePanel
        selection={LINEAGE_SELECTION}
        onClose={() => {}}
        fetchLineageFn={async () => okResult(LINEAGE_RECORDS)}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("lineage-records")).toBeTruthy());
    expect(screen.getByText("INV-2026-0841")).toBeTruthy();
    // Focus follows the reader into the drawer (T8).
    expect(document.activeElement?.getAttribute("data-testid")).toBe("lineage-close");
    await expectNoViolations(container);
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    renderPanel(
      <LineagePanel
        selection={LINEAGE_SELECTION}
        onClose={onClose}
        fetchLineageFn={async () => okResult(LINEAGE_RECORDS)}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("lineage-records")).toBeTruthy());
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("offers an in-place retry when the fetch fails", async () => {
    // Providers sets "retry: 1", so the first failure is retried before the
    // panel can show its error state; the third call is the user clicking
    // "Try again".
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(errorResult("connection reset"))
      .mockResolvedValueOnce(errorResult("connection reset"))
      .mockResolvedValueOnce(okResult(LINEAGE_RECORDS));
    renderPanel(
      <LineagePanel
        selection={LINEAGE_SELECTION}
        onClose={() => {}}
        fetchLineageFn={fetch}
      />,
    );
    // The default retry backoff delays the second failure by ~1s, so the
    // waitFor needs more than its default timeout to see the error state.
    await waitFor(() => expect(screen.getByTestId("lineage-retry")).toBeTruthy(), {
      timeout: 4000,
    });
    await userEvent.click(screen.getByTestId("lineage-retry"));
    await waitFor(() => expect(screen.getByTestId("lineage-records")).toBeTruthy());
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe("CopilotPanel", () => {
  it("starts idle with the submit disabled, and passes axe", async () => {
    const { container } = renderPanel(<CopilotPanel />);
    expect(screen.getByText(/Answers are built from rows/)).toBeTruthy();
    const submit = screen.getByTestId("copilot-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await expectNoViolations(container);
  });

  it("asks, streams a skeleton, then renders the answer with citations", async () => {
    const user = userEvent.setup();
    const askQuestion = vi.fn().mockImplementation(async () => AGENT_ANSWER);
    renderPanel(<CopilotPanel askQuestion={askQuestion} />);

    await user.type(screen.getByTestId("copilot-question"), "Which invoices are overdue?");
    await user.click(screen.getByTestId("copilot-submit"));

    // TanStack Query calls the mutationFn with (variables, context).
    expect(askQuestion).toHaveBeenCalledWith("Which invoices are overdue?", expect.any(Object));
    await waitFor(() => expect(screen.getByTestId("copilot-answer")).toBeTruthy());
    const citations = screen.getAllByTestId("copilot-citation");
    expect(citations.length).toBe(3);
    // The unverified citation stays in place and is marked. (AC: never hide.)
    expect(screen.getByTestId("copilot-unverified")).toBeTruthy();
    await expectNoViolations(screen.getByTestId("copilot-answer").parentElement as HTMLElement);
  });

  it("shows the error and keeps the form as the retry", async () => {
    const user = userEvent.setup();
    const askQuestion = vi.fn().mockRejectedValue(new Error("the model provider timed out"));
    renderPanel(<CopilotPanel askQuestion={askQuestion} />);

    await user.type(screen.getByTestId("copilot-question"), "Which invoices are overdue?");
    await user.click(screen.getByTestId("copilot-submit"));

    await waitFor(() => expect(screen.getByTestId("copilot-error")).toBeTruthy());
    expect(screen.getByTestId("panel-error").textContent).toContain("model provider timed out");
    // No reload button: the Ask button stays enabled, so the form is the retry.
    expect(screen.queryByTestId("panel-retry")).toBeNull();
    const submit = screen.getByTestId("copilot-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
  });
});
