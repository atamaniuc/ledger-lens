import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";
import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";

// Stories as tests (spec 0006 T1/T2, D-07): every story in
// src/components/**/*.stories.tsx runs through Storybook's own renderer in a
// real Chromium page. The storybookTest plugin reads .storybook/main.ts, so
// the story set is declared in exactly one place — Storybook and this test
// project cannot drift apart.
//
// next/link and next/navigation are aliased to local mocks (same reason as
// the components project: the real modules touch "process" at module scope,
// which a browser page does not have, and the Next storybook framework's own
// module-alias mock breaks Node ESM outright — see .storybook/main.ts).
export default defineProject({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "next/link": fileURLToPath(new URL("./.storybook/mocks/next-link.tsx", import.meta.url)),
      "next/navigation": fileURLToPath(new URL("./.storybook/mocks/next-navigation.ts", import.meta.url)),
    },
  },
  plugins: [await storybookTest()],
  define: {
    "process.env.NEXT_PUBLIC_SUPABASE_URL": JSON.stringify("http://127.0.0.1:54321"),
    "process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY": JSON.stringify(
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlhdCI6MTcyMDAwMDAwMH0.test",
    ),
  },
  test: {
    name: "stories",
    // Same rule as the components project (D-51): one retry, printed by the
    // reporter, because a real browser page on a loaded machine flakes; two
    // consecutive failures are still a failure.
    retry: 1,
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
      headless: true,
      screenshotDirectory: "test-results/browser-screenshots",
    },
  },
});
