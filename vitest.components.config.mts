import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";

// Browser-mode component tests (spec 0006 T6): a real Chromium page, where
// axe can judge actual colours and keyboard focus is real. Defined as its own
// config file and wired into the root config's "projects" array, so the
// node-environment unit suite is untouched.
//
// next/link and next/navigation are aliased to local mocks at the Vite level
// — before any prebundling — because the real modules touch "process" at
// module scope and die in a browser page, and a vi.mock in the test file is
// bypassed by the prebundled copy.
export default defineProject({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "next/link": fileURLToPath(new URL("./.storybook/mocks/next-link.tsx", import.meta.url)),
      "next/navigation": fileURLToPath(new URL("./.storybook/mocks/next-navigation.ts", import.meta.url)),
    },
  },
  plugins: [react()],
  // The browser page has no "process": Vite would inline NEXT_PUBLIC_* from
  // the environment, but vitest's env loading does not reach this bundle, so
  // config.ts's "process.env.NEXT_PUBLIC_..." would throw at runtime. The
  // panels construct a Supabase client in their query functions even when the
  // query itself is injected — the values just need to exist and parse.
  define: {
    "process.env.NEXT_PUBLIC_SUPABASE_URL": JSON.stringify("http://127.0.0.1:54321"),
    "process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY": JSON.stringify(
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlhdCI6MTcyMDAwMDAwMH0.test",
    ),
  },
  test: {
    name: "components",
    include: ["src/components/**/*.test.tsx"],
    setupFiles: ["./vitest.browser.setup.ts"],
    // One retry, and it is never silent (D-51): a real Chromium page under a
    // loaded machine flaked once in a full `task check` — the identical re-run
    // was green twice. Vitest's reporter prints a retried test as such, so a
    // flake still shows up in the log instead of being smoothed away; what a
    // retry buys is that a gate does not go red for a reason the code cannot
    // fix. A second consecutive failure is still a failure.
    retry: 1,
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
      headless: true,
      // test-results/ is gitignored (Playwright already uses it); failure
      // screenshots must not land next to the components.
      screenshotDirectory: "test-results/browser-screenshots",
    },
  },
});
