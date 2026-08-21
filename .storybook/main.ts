import { fileURLToPath } from "node:url";
import type { StorybookConfig } from "@storybook/react-vite";

// Storybook is a test source, not a second frontend project (spec 0006).
// Stories exist only for components that pay for them: the shadcn primitives
// used by two or more surfaces, the dashboard panels in all four states, and
// the copilot panel. Every story also runs as a Vitest test through
// @storybook/addon-vitest, so a story that is only a picture rots on the next
// "task check".
//
// Framework is @storybook/react-vite, deliberately not the Next.js one:
// vite-plugin-storybook-nextjs registers a Node module-alias redirecting
// react to a directory that Node 22+ ESM cannot load, which breaks the vitest
// story runner. The one Next import the storied components make (next/link)
// is aliased to a local mock below.
const config: StorybookConfig = {
  stories: ["../src/components/**/*.stories.tsx"],
  addons: ["@storybook/addon-vitest"],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  viteFinal: (viteConfig) => {
    const existing = Array.isArray(viteConfig.resolve?.alias)
      ? viteConfig.resolve!.alias
      : Object.entries((viteConfig.resolve?.alias ?? {}) as Record<string, string>).map(
          ([find, replacement]) => ({ find, replacement }),
        );
    return {
      ...viteConfig,
      resolve: {
        ...viteConfig.resolve,
        alias: [
          ...existing,
          {
            find: "next/link",
            replacement: fileURLToPath(new URL("./mocks/next-link.tsx", import.meta.url)),
          },
        ],
      },
    };
  },
};

export default config;
