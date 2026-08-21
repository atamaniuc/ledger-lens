// Every claim in the human documentation carries a machine-checked proof.
//
// The disease this cures: for weeks README.md said "all deployable
// infrastructure is stood up through a single Pulumi program in infra/" while
// infra/ did not exist, and "LLM-as-judge groundedness blocks the merge" three
// screens above a TODO admitting it was not computed. Ten such claims came out
// of one audit (D-01..D-10). Prose cannot be trusted to stay true on its own,
// so the documents name their evidence and a gate fails when the evidence is
// gone.
//
// Marker syntax, in an HTML comment so it never renders:
//
//   <!-- proof: src/features/rag/search.ts -->                   the file exists
//   <!-- proof: src/features/rag/search.ts:searchChunks -->       ...and contains that text
//   <!-- proof: tests/rls-coverage.spec.ts#every table in public has row level security enabled -->
//   <!-- proof: task check-infra -->                             the Taskfile defines that task
//   <!-- proof: migration:20260821110000 -->                      a migration with that prefix exists
//
// This module is the pure half: no filesystem, so it is unit-testable. The CLI
// that walks the repository is scripts/verify-docs.ts.

export const MARKER = /<!--\s*proof:\s*(.+?)\s*-->/g;

/** Documents whose claims must be evidenced once the gate runs in strict mode. */
export const MUST_CARRY_PROOF = ["README.md", "docs/ARCHITECTURE.md"];

export interface Problem {
  file: string;
  line: number;
  target: string;
  reason: string;
}

export interface Resolver {
  fileExists(path: string): boolean;
  readFile(path: string): string;
  taskNames(): string[];
  migrationNames(): string[];
}

export function checkTarget(target: string, resolver: Resolver): string | null {
  if (target.startsWith("task ")) {
    const name = target.slice(5).trim();
    return resolver.taskNames().includes(name) ? null : `Taskfile has no task "${name}"`;
  }
  if (target.startsWith("migration:")) {
    const prefix = target.slice("migration:".length).trim();
    return resolver.migrationNames().some((m) => m.startsWith(prefix))
      ? null
      : `no migration starts with "${prefix}"`;
  }
  const hash = target.indexOf("#");
  if (hash !== -1) {
    const path = target.slice(0, hash).trim();
    const needle = target.slice(hash + 1).trim();
    if (!resolver.fileExists(path)) return `file "${path}" does not exist`;
    return resolver.readFile(path).includes(needle)
      ? null
      : `"${path}" does not contain "${needle}"`;
  }
  const colon = target.lastIndexOf(":");
  if (colon > 1) {
    const path = target.slice(0, colon).trim();
    const symbol = target.slice(colon + 1).trim();
    if (!resolver.fileExists(path)) return `file "${path}" does not exist`;
    return resolver.readFile(path).includes(symbol)
      ? null
      : `"${path}" does not contain "${symbol}"`;
  }
  return resolver.fileExists(target) ? null : `file "${target}" does not exist`;
}

/**
 * A marker that documents the syntax rather than making a claim.
 *
 * The rule has to exist because the specs and AGENTS.md explain how to write a
 * marker, and their examples are written as markers. Placeholder punctuation —
 * `...`, `[optional]`, `<angle>` — is what separates an illustration from an
 * assertion, and no real path in this repository contains any of it.
 */
export function isSyntaxExample(target: string): boolean {
  return /\.\.\.|[[\]<>|]/.test(target);
}

export function findMarkers(text: string): { line: number; target: string }[] {
  const found: { line: number; target: string }[] = [];
  text.split("\n").forEach((lineText, index) => {
    for (const match of lineText.matchAll(MARKER)) {
      if (isSyntaxExample(match[1])) continue;
      found.push({ line: index + 1, target: match[1] });
    }
  });
  return found;
}

export function verify(
  files: { path: string; text: string }[],
  resolver: Resolver,
  strict: boolean,
): Problem[] {
  const problems: Problem[] = [];
  for (const file of files) {
    const markers = findMarkers(file.text);
    if (strict && MUST_CARRY_PROOF.includes(file.path) && markers.length === 0) {
      problems.push({
        file: file.path,
        line: 1,
        target: "(none)",
        reason:
          "carries no proof marker; a claim with no evidence at all is the defect this gate exists for",
      });
    }
    for (const marker of markers) {
      const reason = checkTarget(marker.target, resolver);
      if (reason) {
        problems.push({ file: file.path, line: marker.line, target: marker.target, reason });
      }
    }
  }
  return problems;
}
