// File-content triggers for the command-wrapped steps (spec 0010).
//
// A `@pulumi/command` local.Command only re-runs when one of its `triggers`
// changes. A command with a static trigger is a lie of a different kind: it
// would never re-run after a changed migration or function. Every step here
// therefore gets a single sha256 digest derived from exactly the files it
// depends on — change a migration or a function and `pulumi up` re-runs the
// matching step.
//
// All paths are repo-root-relative and resolved from the Pulumi program's
// working directory, which is `infra/` by convention (`cd infra && pulumi up`
// or `pulumi -C infra up`). assertRepoLayout() guards that contract.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export const INFRA_DIR = process.cwd();
export const REPO_ROOT = resolve(INFRA_DIR, "..");

/** Fail loudly (before anything is registered) if we are not running from infra/. */
export function assertRepoLayout(): void {
  const markers = [
    ["infra/Pulumi.yaml", join(INFRA_DIR, "Pulumi.yaml")],
    ["repo supabase/", join(REPO_ROOT, "supabase")],
    ["repo .env.example", join(REPO_ROOT, ".env.example")],
  ];
  const missing = markers.filter(([, abs]) => !existsSync(abs)).map(([label]) => label);
  if (missing.length > 0) {
    throw new Error(
      `infra/ program must run with infra/ as the working directory (cd infra && pulumi up). Missing: ${missing.join(", ")}`,
    );
  }
}

export function hashFile(rel: string): string {
  const abs = join(REPO_ROOT, rel);
  if (!existsSync(abs)) {
    throw new Error(`trigger file missing: ${rel} — update the trigger list in supabase.ts`);
  }
  return createHash("sha256").update(readFileSync(abs)).digest("hex");
}

function walkFiles(relDir: string, out: string[] = []): string[] {
  const abs = join(REPO_ROOT, relDir);
  for (const entry of readdirSync(abs, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const p = join(relDir, entry.name);
    if (entry.isDirectory()) walkFiles(p, out);
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

/**
 * One deterministic digest for a list of repo-root-relative files and/or
 * directories (directories are walked recursively). Sorting makes the digest
 * independent of directory iteration order.
 */
export function fileTrigger(rels: string[]): string {
  const parts: string[] = [];
  for (const rel of rels) {
    const abs = join(REPO_ROOT, rel);
    if (!existsSync(abs)) throw new Error(`trigger path missing: ${rel}`);
    if (statSync(abs).isDirectory()) {
      for (const p of walkFiles(rel)) parts.push(`${p}:${hashFile(p)}`);
    } else {
      parts.push(`${rel}:${hashFile(rel)}`);
    }
  }
  parts.sort();
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

/** sha256 of a runtime value (used as a trigger for secret-value changes). */
export function valueHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
