import type { Meta, StoryObj } from "@storybook/react";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./card";
import { Button } from "./button";

// The Card family is the chrome behind every dashboard panel (via Panel) and
// the landing and login pages — three surfaces, so it earns a story.
const meta = {
  title: "UI/Card",
  component: Card,
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Pipeline overview</CardTitle>
        <CardDescription>Everything your organisation ingested, in one place.</CardDescription>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        Five independent queries, one page, one set of policies.
      </CardContent>
    </Card>
  ),
};

export const WithAction: Story = {
  render: () => (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Lineage · Total invoiced</CardTitle>
        <CardAction>
          <Button type="button" variant="ghost" size="xs">Close</Button>
        </CardAction>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        The drawer every figure opens, with its action in the header.
      </CardContent>
    </Card>
  ),
};

export const Small: Story = {
  render: () => (
    <Card size="sm" className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Compact</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        The smaller spacing variant used for dense panels.
      </CardContent>
    </Card>
  ),
};
