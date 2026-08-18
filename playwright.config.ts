import { existsSync, readFileSync } from "node:fs";
import { defineConfig } from "@playwright/test";

// End-to-end checks against a locally running LedgerLens: the Next.js app
// and the local Supabase stack. See docs/LOCAL_DEV.md.
//
// These replaced a shell script. The assertions are the same ones; what
// changed is that they are typed, name the value that failed instead of
// printing two strings that did not match, and cannot silently pass when a
// field is missing — which is the failure mode the shell version kept
// finding in itself.

// Loaded here rather than by each spec so a missing .env.local fails once,
// at startup, with a sentence that says what to do. Read synchronously with
// node:fs rather than Bun.file: Playwright loads this config through Node,
// where neither the Bun global nor top-level await exists.
if (!existsSync(".env.local")) {
  throw new Error(".env.local not found — run `make dev-up`, then see docs/LOCAL_DEV.md");
}
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

export default defineConfig({
  testDir: "./tests",
  globalTeardown: "./tests/global-teardown.ts",
  // Stage 2 and 3 mutate shared pipeline state — cursors, runs, results —
  // so files must not race each other. Within a file, tests run in order.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:3000",
    extraHTTPHeaders: { "content-type": "application/json" },
  },
  webServer: {
    command: "bun run dev",
    url: "http://localhost:3000/api/mock-provider/summary",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
