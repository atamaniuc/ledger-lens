import { within } from "@testing-library/dom";
import { userEvent } from "@testing-library/user-event";
import type { Meta, StoryObj } from "@storybook/react";
import { AGENT_ANSWER, AGENT_ANSWER_ABSTAINED, AGENT_ANSWER_UNCITED } from "./panel-fixtures";
import {
  CopilotPanel,
  RateLimitedError,
  TurnCancelledError,
  TurnError,
  UnconfiguredError,
} from "./copilot-panel";

// The chat panel in every state it has. Idle is the empty state — no
// question asked yet. The pending state is reached by actually asking
// (through the injected askQuestion), because a streaming skeleton that no
// code path reaches would be a picture, not a state. Spec 0006 runs every
// story as a test, so a new state (cancelled) is a new story.
const meta = {
  title: "Dashboard/CopilotPanel",
  component: CopilotPanel,
} satisfies Meta<typeof CopilotPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

async function ask(canvasElement: HTMLElement, question: string) {
  const canvas = within(canvasElement);
  await userEvent.type(canvas.getByTestId("copilot-question"), question);
  await userEvent.click(canvas.getByTestId("copilot-submit"));
}

export const Idle: Story = {};

export const Streaming: Story = {
  args: {
    // The turn never settles, but the steps are real: the panel has to show
    // that a running answer is doing something, not just that it is loading.
    askQuestion: (_q, { onStep }) => {
      onStep({ type: "step", stepNo: 0, tool: "search_documents", args: { query: "overdue" } });
      onStep({ type: "tool_result", stepNo: 0, tool: "search_documents", summary: "3 chunks" });
      onStep({ type: "tokens", text: "Three invoices are overdue: " });
      return new Promise(() => {});
    },
  },
  play: async ({ canvasElement }) => {
    await ask(canvasElement, "Which invoices are overdue?");
  },
};

export const Cancelled: Story = {
  args: {
    // The stub behaves like the real route: it emits the steps that ran,
    // then rejects when the panel's Cancel button aborts the request.
    askQuestion: (_q, { signal, onStep }) =>
      new Promise((_resolve, reject) => {
        onStep({ type: "step", stepNo: 0, tool: "search_documents", args: { query: "overdue" } });
        signal.addEventListener("abort", () => reject(new TurnCancelledError()), { once: true });
      }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await ask(canvasElement, "Which invoices are overdue?");
    await userEvent.click(canvas.getByTestId("copilot-cancel"));
    await canvas.findByTestId("copilot-cancelled");
  },
};

export const Answered: Story = {
  args: { askQuestion: async () => AGENT_ANSWER },
  play: async ({ canvasElement }) => {
    await ask(canvasElement, "Which invoices are overdue?");
  },
};

export const UnverifiedCitation: Story = {
  args: { askQuestion: async () => AGENT_ANSWER },
  play: async ({ canvasElement }) => {
    await ask(canvasElement, "Which invoices are overdue?");
  },
};

export const Abstained: Story = {
  args: { askQuestion: async () => AGENT_ANSWER_ABSTAINED },
  play: async ({ canvasElement }) => {
    await ask(canvasElement, "What is the total?");
  },
};

export const UncitedAnswer: Story = {
  args: { askQuestion: async () => AGENT_ANSWER_UNCITED },
  play: async ({ canvasElement }) => {
    await ask(canvasElement, "How many invoices were processed?");
  },
};

export const ServerError: Story = {
  args: {
    askQuestion: async () => {
      throw new TurnError("the model provider timed out", "corr_story_0001");
    },
  },
  play: async ({ canvasElement }) => {
    await ask(canvasElement, "Which invoices are overdue?");
  },
};

export const NotConfigured: Story = {
  args: {
    askQuestion: async () => {
      throw new UnconfiguredError("the copilot is not configured");
    },
  },
  play: async ({ canvasElement }) => {
    await ask(canvasElement, "Which invoices are overdue?");
  },
};

export const RateLimited: Story = {
  args: {
    askQuestion: async () => {
      throw new RateLimitedError("the copilot is rate-limited right now", 20);
    },
  },
  play: async ({ canvasElement }) => {
    await ask(canvasElement, "Which invoices are overdue?");
  },
};
