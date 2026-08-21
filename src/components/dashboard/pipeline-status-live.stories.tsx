import type { Meta, StoryObj } from "@storybook/react";
import { PipelineStatusLive } from "./pipeline-status-live";
import { RECENT_RUNS } from "./panel-fixtures";

// The story renders without a LiveRefreshProvider: the provider default
// ("connecting") is exactly the state the reader sees before the socket
// opens, and the live/degraded badges are covered by the realtime contract
// tests, not by a picture.
const meta = {
  title: "Dashboard/PipelineStatusLive",
  component: PipelineStatusLive,
} satisfies Meta<typeof PipelineStatusLive>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { runs: RECENT_RUNS },
};

export const Loading: Story = {
  args: { runs: RECENT_RUNS, isLoading: true },
};

export const Empty: Story = {
  args: { runs: [] },
};

export const Error: Story = {
  args: { runs: [], error: "connection reset by the database" },
};
