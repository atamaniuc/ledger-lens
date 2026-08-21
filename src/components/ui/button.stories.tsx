import type { Meta, StoryObj } from "@storybook/react";
import { Button } from "./button";

// Button is used by three surfaces — landing, login and the dashboard — so it
// earns a story (spec 0006, D-07). These run as tests through
// @storybook/addon-vitest, not just as pictures.
const meta = {
  title: "UI/Button",
  component: Button,
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { children: "Ask" },
};

export const Secondary: Story = {
  args: { children: "Secondary", variant: "secondary" },
};

export const Outline: Story = {
  args: { children: "Outline", variant: "outline" },
};

export const Ghost: Story = {
  args: { children: "Ghost", variant: "ghost" },
};

export const Destructive: Story = {
  args: { children: "Delete", variant: "destructive" },
};

export const LinkVariant: Story = {
  args: { children: "Link", variant: "link" },
};

export const Disabled: Story = {
  args: { children: "Disabled", disabled: true },
};

export const Sizes: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-gutter">
      <Button size="xs">Extra small</Button>
      <Button size="sm">Small</Button>
      <Button>Default</Button>
      <Button size="lg">Large</Button>
    </div>
  ),
};
