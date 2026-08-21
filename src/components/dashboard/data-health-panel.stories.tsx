import type { Meta, StoryObj } from "@storybook/react";
import { DataHealthPanel } from "./data-health-panel";
import {
  HEALTH_DEFAULT,
  HEALTH_EMPTY,
  HEALTH_MISSING_CHECKS,
  HEALTH_NO_VERDICT,
  errorResult,
  okResult,
} from "./panel-fixtures";

// The four states AC-02 asks for (default/loading/empty/error), plus the two
// the panel is built to keep apart: no-verdict and missing checks (US-04).
const meta = {
  title: "Dashboard/DataHealthPanel",
  component: DataHealthPanel,
} satisfies Meta<typeof DataHealthPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { result: okResult(HEALTH_DEFAULT) },
};

export const Loading: Story = {
  args: { result: okResult(HEALTH_DEFAULT), isLoading: true },
};

export const Empty: Story = {
  args: { result: okResult(HEALTH_EMPTY) },
};

export const Error: Story = {
  args: { result: errorResult("connection reset by the database") },
};

export const NoVerdict: Story = {
  args: { result: okResult(HEALTH_NO_VERDICT) },
};

export const MissingChecks: Story = {
  args: { result: okResult(HEALTH_MISSING_CHECKS) },
};
