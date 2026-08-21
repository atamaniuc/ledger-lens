import type { Meta, StoryObj } from "@storybook/react";
import { StatusBadge, type BadgeState } from "./status-badge";

// The project's own state primitive: three dashboard panels render it, so it
// earns a story. Six states, not four — "missing" and "unknown" are not
// "fail", and the story is where that difference stays visible.
const meta = {
  title: "UI/StatusBadge",
  component: StatusBadge,
} satisfies Meta<typeof StatusBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

const STATES: BadgeState[] = ["pass", "warn", "fail", "unknown", "missing"];

export const AllStates: Story = {
  args: { state: "pass" },
  render: () => (
    <div className="flex flex-wrap items-center gap-gutter">
      {STATES.map((state) => (
        <StatusBadge key={state} state={state} />
      ))}
    </div>
  ),
};

export const CustomLabels: Story = {
  args: { state: "pass" },
  render: () => (
    <div className="flex flex-wrap items-center gap-gutter">
      <StatusBadge state="pass" label="Fresh · 4 minutes ago" />
      <StatusBadge state="warn" label="Stale · 5 hours ago" />
      <StatusBadge state="fail" label="Failed" />
      <StatusBadge state="unknown" label="Freshness unknown" />
      <StatusBadge state="missing" label="No data yet" />
    </div>
  ),
};
