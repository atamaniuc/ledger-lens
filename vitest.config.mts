import { fileURLToPath } from "node:url";
import { defineConfig, type TestProjectConfiguration } from "vitest/config";

// Three projects, additive. The unit suite is the original config untouched:
// pure Node, no DOM, `src/**/*.test.ts`. The two browser projects live in
// their own config files (vitest.stories.config.mts,
// vitest.components.config.mts) because Vitest 4 drops an inline project
// whose browser config lives under test.browser, while a project config file
// resolves it properly. `pnpm test` = `vitest run` runs all three.
const alias = {
  // tsconfig.json's "@/*" path alias — Vitest needs it spelled out
  // (src/features/dashboard/queries.ts imports "@/...").
  "@": fileURLToPath(new URL("./src", import.meta.url)),
};

const projects: TestProjectConfiguration[] = [
  {
    resolve: { alias },
    test: {
      name: "unit",
      environment: "node",
      include: ["src/**/*.test.ts"],
    },
  },
  "./vitest.stories.config.mts",
  "./vitest.components.config.mts",
];

export default defineConfig({
  test: {
    watch: false,
    projects,
  },
});
