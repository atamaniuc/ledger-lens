// CLI half of the gated-task-state check (spec 0017, D-63). The logic and
// its unit tests live in src/platform/tasks-proof.ts; this file is the
// filesystem edge — same split as scripts/verify-docs.ts, and it reuses that
// script's own node Resolver shape rather than inventing a second one.
//
// Usage: pnpm exec tsx scripts/verify-tasks.ts

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Resolver } from "../src/platform/docs-proof";
import { verifyTaskGates } from "../src/platform/tasks-proof";

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

function collectTasksFiles(root: string): { path: string; text: string }[] {
  const specsDir = join(root, "specs");
  if (!existsSync(specsDir)) return [];
  const out: { path: string; text: string }[] = [];
  for (const entry of readdirSync(specsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const rel = `specs/${entry.name}/tasks.md`;
    if (existsSync(join(root, rel))) {
      out.push({ path: rel, text: readFileSync(join(root, rel), "utf8") });
    }
  }
  return out;
}

const root = process.cwd();
const tracksPath = join(root, "specs/TRACKS.md");
const tracksText = existsSync(tracksPath) ? readFileSync(tracksPath, "utf8") : "";
const files = collectTasksFiles(root);
const problems = verifyTaskGates(files, tracksText, nodeResolver(root));

if (problems.length === 0) {
  console.log(
    `verify-tasks: ${files.length} tasks.md scanned, no gated checked-task problems in live tracks.`,
  );
  process.exit(0);
}
for (const problem of problems) {
  console.error(`${problem.file}:${problem.line}  ${problem.target}\n    ${problem.reason}`);
}
console.error(`\nverify-tasks: ${problems.length} problem(s).`);
process.exit(1);
