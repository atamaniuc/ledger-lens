import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // An unused disable directive is an error, not a warning. That is what
    // makes the boundary fixture below a real gate: delete the rule and its
    // `eslint-disable` comment becomes unused, so lint goes red instead of
    // quietly passing over a rule nobody enforces any more.
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },
  {
    // The service-role key bypasses RLS. Importing this client into anything
    // that renders a page would work perfectly, return every tenant's rows,
    // and pass any test that only checks the numbers are right (ADR 0007).
    // The file-level comments are advice; this is enforcement.
    //
    // `src/app/api/**` is exempt because those routes act as the pipeline rather
    // than as a user. `supabase/functions/**` is exempt by being outside
    // this config entirely — it is checked by `deno check`.
    files: ["**/*.ts", "**/*.tsx"],
    // `scripts/**` is exempt for a different reason than src/app/api/**: those
    // files are a developer CLI run against a local stack. They are outside
    // the Next.js build entirely, so nothing there can end up in a browser
    // bundle — which is the risk this rule exists to stop.
    ignores: ["src/app/api/**", "src/platform/supabase/service-client.ts", "scripts/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@/platform/supabase/service-client",
                "**/platform/supabase/service-client",
                "./service-client",
                "../service-client",
              ],
              message:
                "The service-role client bypasses RLS. Outside src/app/api/** and supabase/functions/**, read through src/platform/supabase/server-client.ts or browser-client.ts so Postgres decides what comes back (ADR 0007).",
            },
          ],
        },
      ],
    },
  },
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
    // Supabase CLI scratch space, written by `supabase start`. It is
    // gitignored but eslint walks the working tree, not the index, so a
    // running local stack drops a bundled edge-runtime file here and turns
    // `bun run lint` red with ~150 errors from vendored code.
    "supabase/.temp/**",
    "supabase/.branches/**",
    // Playwright run artifacts — traces, screenshots, HTML reports.
    "test-results/**",
    "playwright-report/**",
    // The Python services (spec 0005). Nothing there is part of the Next.js
    // app, and its virtualenvs and uv cache carry vendored JavaScript —
    // torch and scikit-learn each ship a browser bundle — which turned this
    // gate red with 150 problems from code nobody here wrote. Python is
    // linted by ruff, in its own CI job.
    "py/**",
    // The Pulumi program (spec 0010). Self-contained like py/: its own
    // package.json, tsconfig and tests; deployed by pulumi, not built by Next.
    "infra/**",
  ]),
]);

export default eslintConfig;