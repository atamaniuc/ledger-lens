import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each file gets its own worker: Pulumi resource registration and mocks
    // are process-global, so isolation between files must be process-level.
    pool: "forks",
    include: ["__tests__/**/*.test.ts"],
  },
});
