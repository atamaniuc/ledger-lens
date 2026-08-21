import type { Meta, StoryObj } from "@storybook/react";
import { MetricTiles } from "./metric-tiles";
import {
  LINEAGE_SELECTION,
  METRICS_DEFAULT,
  METRICS_EMPTY,
  METRICS_MIXED_CURRENCY,
  errorResult,
  okResult,
} from "./panel-fixtures";

const meta = {
  title: "Dashboard/MetricTiles",
  component: MetricTiles,
} satisfies Meta<typeof MetricTiles>;

export default meta;
type Story = StoryObj<typeof meta>;

const lineage = LINEAGE_SELECTION.lineage;

export const Default: Story = {
  args: { result: okResult(METRICS_DEFAULT), lineage },
};

export const Loading: Story = {
  args: { result: okResult(METRICS_DEFAULT), lineage, isLoading: true },
};

export const Empty: Story = {
  args: { result: okResult(METRICS_EMPTY), lineage },
};

export const MixedCurrency: Story = {
  args: { result: okResult(METRICS_MIXED_CURRENCY), lineage },
};

export const Error: Story = {
  args: { result: errorResult("permission denied for table invoices"), lineage },
};
