import type { Meta, StoryObj } from "@storybook/react";
import { Skeleton } from "./skeleton";
import { PanelSkeleton } from "./panel-skeleton";

// Skeleton is the loading state of two dashboard panels (copilot, lineage),
// and PanelSkeleton shapes every panel's loading story and the route-level
// loading page. Both are in one story file because they are one idea: the
// shape of the page before the data lands.
const meta = {
  title: "UI/Skeleton",
  component: Skeleton,
} satisfies Meta<typeof Skeleton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Line: Story = {
  args: { className: "h-4 w-full" },
};

export const Panel: Story = {
  render: () => <PanelSkeleton label="Data health loading" lines={4} />,
};
