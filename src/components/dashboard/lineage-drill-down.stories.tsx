import type { Meta, StoryObj } from "@storybook/react";
import { LineagePanel } from "./lineage-drill-down";
import {
  LINEAGE_RECORDS,
  LINEAGE_SELECTION,
  errorResult,
  okResult,
} from "./panel-fixtures";

// The drawer driven through its exported panel with an injected fetcher, so
// each state is a state of a query rather than of a network stub. The Close
// button and Escape handling are exercised in the component tests.
const meta = {
  title: "Dashboard/LineageDrawer",
  component: LineagePanel,
} satisfies Meta<typeof LineagePanel>;

export default meta;
type Story = StoryObj<typeof meta>;

const selection = LINEAGE_SELECTION;

export const Default: Story = {
  args: {
    selection,
    onClose: () => {},
    fetchLineageFn: async () => okResult(LINEAGE_RECORDS),
  },
};

export const Loading: Story = {
  args: {
    selection,
    onClose: () => {},
    fetchLineageFn: () => new Promise(() => {}),
  },
};

export const Empty: Story = {
  args: {
    selection,
    onClose: () => {},
    fetchLineageFn: async () => okResult([]),
  },
};

export const Error: Story = {
  args: {
    selection,
    onClose: () => {},
    fetchLineageFn: async () => errorResult("connection reset by the database"),
  },
};
