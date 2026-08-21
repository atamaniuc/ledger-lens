import type { Meta, StoryObj } from "@storybook/react";
import { InvoicesTable } from "./invoices-table";
import { INVOICES_DEFAULT, INVOICES_EMPTY, errorResult, okResult } from "./panel-fixtures";

const meta = {
  title: "Dashboard/InvoicesTable",
  component: InvoicesTable,
} satisfies Meta<typeof InvoicesTable>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { result: okResult(INVOICES_DEFAULT) },
};

export const Loading: Story = {
  args: { result: okResult(INVOICES_DEFAULT), isLoading: true },
};

export const Empty: Story = {
  args: { result: okResult(INVOICES_EMPTY) },
};

export const Error: Story = {
  args: { result: errorResult("relation invoices does not exist") },
};
