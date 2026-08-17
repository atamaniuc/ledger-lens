import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Parallel-agent git worktrees (CLAUDE.md "Parallel Execution").
    // Each one carries its own node_modules and .next build output; the
    // default ignores above only match those at the repo root, so without
    // this `bun run lint` reports hundreds of errors from generated code
    // in sibling worktrees and stops being a usable gate.
    ".worktrees/**",
    // Deno Edge Functions — npm: specifiers, Deno globals, and .ts import
    // extensions don't parse under the Next.js app's config. Excluded from
    // tsconfig.json for the same reason; check them with `deno check`.
    "supabase/functions/**",
  ]),
]);

export default eslintConfig;
