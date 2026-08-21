// CLI half of the documentation proof gate. The logic and its unit tests live
// in src/platform/docs-proof.ts; this file is the filesystem edge.
//
// Usage: pnpm exec tsx scripts/verify-docs.ts [--strict] [file...]
//   --strict also requires each document in MUST_CARRY_PROOF to carry at least
//   one marker, which is what turns "the docs may lie" into "the docs cannot".

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { findMarkers, verify, type Resolver } from "../src/platform/docs-proof";

const SEARCH_ROOTS = [".", "docs", "specs", "decisions"];
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "py",
  "infra",
  ".worktrees",
  "storybook-static",
  "interview-preps",
]);

function collectDocs(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name.endsWith(".md")) out.push(relative(root, full));
    }
  };
  for (const sub of SEARCH_ROOTS) {
    const dir = join(root, sub);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    if (sub === ".") {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".md")) out.push(entry.name);
      }
    } else {
      walk(dir, 0);
    }
  }
  return [...new Set(out)].sort();
}

function nodeResolver(root: string): Resolver {
  return {
    fileExists: (path) => existsSync(join(root, path)),
    readFile: (path) => readFileSync(join(root, path), "utf8"),
    taskNames: () => {
      const taskfile = readFileSync(join(root, "Taskfile.yml"), "utf8");
      return [...taskfile.matchAll(/^ {2}([A-Za-z][\w:-]*):$/gm)].map((m) => m[1]);
    },
    migrationNames: () => readdirSync(join(root, "supabase/migrations")),
  };
}

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const explicit = args.filter((a) => !a.startsWith("--"));
const root = process.cwd();
const paths = explicit.length > 0 ? explicit : collectDocs(root);
const files = paths.map((path) => ({ path, text: readFileSync(join(root, path), "utf8") }));
const problems = verify(files, nodeResolver(root), strict);
const markerCount = files.reduce((n, f) => n + findMarkers(f.text).length, 0);

if (problems.length === 0) {
  console.log(
    `verify-docs: ${markerCount} proof marker(s) across ${files.length} document(s) all resolve${
      strict ? " (strict)" : ""
    }.`,
  );
  process.exit(0);
}
for (const problem of problems) {
  console.error(`${problem.file}:${problem.line}  proof: ${problem.target}\n    ${problem.reason}`);
}
console.error(`\nverify-docs: ${problems.length} unresolved proof marker(s).`);
process.exit(1);
