import type { Meta, StoryObj } from "@storybook/react";
import { FreshnessBadge } from "./freshness-badge";
import {
  FRESHNESS_EMPTY,
  FRESHNESS_FRESH,
  FRESHNESS_STALE,
  FRESHNESS_UNKNOWN,
  errorResult,
  okResult,
} from "./panel-fixtures";

const meta = {
  title: "Dashboard/FreshnessBadge",
  component: FreshnessBadge,
} satisfies Meta<typeof FreshnessBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Fresh: Story = {
  args: { result: okResult(FRESHNESS_FRESH) },
};

export const Stale: Story = {
  args: { result: okResult(FRESHNESS_STALE) },
};

export const Loading: Story = {
  args: { result: okResult(FRESHNESS_FRESH), isLoading: true },
};

export const NoData: Story = {
  args: { result: okResult(FRESHNESS_EMPTY) },
};

export const Unknown: Story = {
  args: { result: okResult(FRESHNESS_UNKNOWN) },
};

export const Error: Story = {
  args: { result: errorResult("connection reset by the database") },
};
