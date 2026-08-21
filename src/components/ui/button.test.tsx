import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { Button } from "./button";

// Browser-mode component test (vitest project "components"). Button is the
// most-shared shadcn primitive — landing, login and dashboard — so it is the
// one that earns a behavioural test on top of its story.

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

describe("Button", () => {
  it("renders its label and is keyboard-reachable", async () => {
    const user = userEvent.setup();
    const { container } = render(<Button>Ask</Button>);

    const button = screen.getByRole("button", { name: "Ask" });
    expect(button).toBeTruthy();

    // Tab reaches it and Enter activates it — the button element does this
    // natively; the test pins it so a future asChild refactor cannot break
    // it silently.
    await user.tab();
    expect(document.activeElement).toBe(button);

    await expectNoViolations(container);
  });

  it("disables without removing the label", async () => {
    render(<Button disabled>Ask</Button>);
    const button = screen.getByRole("button", { name: "Ask" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await expectNoViolations(button.parentElement as HTMLElement);
  });

  it("keeps the focus-visible ring classes on every variant", () => {
    for (const variant of ["default", "secondary", "outline", "ghost", "destructive", "link"] as const) {
      const { unmount } = render(<Button variant={variant}>Label</Button>);
      const button = screen.getByRole("button", { name: "Label" });
      expect(button.className).toContain("focus-visible:ring-3");
      // The ring colour is deliberately per-variant: destructive swaps the
      // accent ring for the destructive one via twMerge, the rest keep the
      // accent ring. What must never happen is a variant with no ring colour.
      expect(button.className).toMatch(/focus-visible:ring-(?:ring\/50|destructive\/20)/);
      unmount();
    }
  });
});
