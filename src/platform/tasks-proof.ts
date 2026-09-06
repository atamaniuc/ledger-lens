// Gated task state (spec 0017, D-63): a checked box in a live lane's
// tasks.md is a claim exactly like a `<!-- proof: ... -->` marker in prose —
// so it is checked the same way, through the same checkTarget every proof
// marker in this repo already goes through, rather than a second, divergent
// notion of "verified". The disease this cures: a checked box today is
// self-reported by the agent that just wrote the code, with nothing re-run
// before it flips — the same failure class DEBT.md already refuses for debt
// items ("ticked only when machine-verifiable"), generalized here.
//
// Scope is deliberately narrow: only tasks.md files for specs currently
// listed as live tracks in specs/TRACKS.md are gated. Every already-shipped
// lane's tasks.md — checked boxes written before this rule existed — is left
// alone (spec 0017's Out of scope: "the gate applies going forward"). The
// moment a lane is retired from TRACKS.md (closed, distilled to
// TRACKS-LOG.md), it drops out of scope here too.
//
// Marker syntax on a checked line is the same one docs already use:
//
//   - [x] **T3** `futureDates` quarantine <!-- proof: tests/future-dates.spec.ts -->
//
// This module is the pure half: no filesystem, so it is unit-testable. The
// CLI that walks the repository is scripts/verify-tasks.ts.

import { checkTarget, isSyntaxExample, type Problem, type Resolver } from "./docs-proof";

const LIST_ITEM = /^-\s*\[[ xX]\]\s/;
const CHECKED_TASK = /^-\s*\[x\]\s/i;
const MARKER = /<!--\s*proof:\s*(.+?)\s*-->/g;

/**
 * Groups a tasks.md into one block per list item, first line through its
 * indented continuation lines — because a real task description wraps (see
 * this spec's own tasks.md), and a marker placed on a continuation line is
 * still the item's marker, not a stray one on the line above it.
 */
function taskBlocks(text: string): { startLine: number; text: string }[] {
  const lines = text.split("\n");
  const blocks: { startLine: number; lines: string[] }[] = [];
  let current: { startLine: number; lines: string[] } | null = null;
  lines.forEach((lineText, index) => {
    if (LIST_ITEM.test(lineText)) {
      current = { startLine: index + 1, lines: [lineText] };
      blocks.push(current);
      return;
    }
    if (current && /^\s+\S/.test(lineText)) {
      current.lines.push(lineText);
      return;
    }
    current = null; // blank line, heading, or dedented content ends the item
  });
  return blocks.map((b) => ({ startLine: b.startLine, text: b.lines.join("\n") }));
}

/**
 * Spec directories currently live per specs/TRACKS.md, derived from each
 * track line's handoff link (`specs/NNNN-<slug>/handoff.md`) — the same
 * link checkTracks (docs-proof.ts) already resolves. A track with no
 * handoff link (an infra-only track like "Hosted deploy") has no tasks.md
 * to gate and is correctly skipped rather than guessed at.
 */
export function liveTrackSpecDirs(tracksText: string): string[] {
  const dirs = new Set<string>();
  for (const m of tracksText.matchAll(/\((specs\/[A-Za-z0-9_.-]+)\/handoff\.md\)/g)) {
    dirs.add(m[1]);
  }
  return [...dirs];
}

/**
 * Checked boxes in one tasks.md, each requiring a `<!-- proof: ... -->`
 * marker: a checked box naming no check is the D-63 failure mode itself
 * (self-reported completion), and a marker whose target does not resolve is
 * caught by the same checkTarget every proof marker in the docs goes
 * through — a stale test name fails a task box exactly as it fails a doc
 * claim.
 */
export function checkTaskGate(text: string, filePath: string, resolver: Resolver): Problem[] {
  const problems: Problem[] = [];
  for (const block of taskBlocks(text)) {
    const firstLine = block.text.split("\n", 1)[0];
    if (!CHECKED_TASK.test(firstLine)) continue;
    const line = block.startLine;
    const markers = [...block.text.matchAll(MARKER)]
      .map((m) => m[1])
      .filter((target) => !isSyntaxExample(target));
    if (markers.length === 0) {
      problems.push({
        file: filePath,
        line,
        target: "(none)",
        reason:
          "checked task names no executable check — add <!-- proof: ... --> naming the test, eval case, or SQL query that proves it (D-63)",
      });
      continue;
    }
    for (const target of markers) {
      const reason = checkTarget(target, resolver);
      if (reason) {
        problems.push({
          file: filePath,
          line,
          target,
          reason: `checked task's proof failed: ${reason}`,
        });
      }
    }
  }
  return problems;
}

/**
 * Runs checkTaskGate over every tasks.md that belongs to a live track (see
 * liveTrackSpecDirs). `files` may list every specs/*\/tasks.md in the repo —
 * only the ones under a currently-live track are actually checked.
 */
export function verifyTaskGates(
  files: { path: string; text: string }[],
  tracksText: string,
  resolver: Resolver,
): Problem[] {
  const liveDirs = new Set(liveTrackSpecDirs(tracksText));
  const problems: Problem[] = [];
  for (const file of files) {
    const dir = file.path.replace(/\/tasks\.md$/, "");
    if (dir === file.path || !liveDirs.has(dir)) continue; // not a tasks.md, or not a live track
    problems.push(...checkTaskGate(file.text, file.path, resolver));
  }
  return problems;
}
