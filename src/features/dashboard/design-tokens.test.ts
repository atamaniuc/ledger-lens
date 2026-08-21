import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// The gate `src/app/globals.css` and `src/components/ui/status-badge.tsx` both claim
// exists. Without it, "design tokens in one file" is a convention that holds
// only as long as everyone remembers it — and the first hardcoded colour is
// invisible in review because it looks exactly like working code.
//
// Scoped to what renders: `src/app/` and `src/components/`. `globals.css` is where
// the literals are supposed to be, so it is the one exemption.

const ROOTS = ["src/app", "src/components"];
const EXTENSIONS = [".tsx", ".ts", ".css"];

// `globals.css` is where the literals belong. The rest are vendored from
// shadcn/ui by its CLI and re-generated rather than hand-edited, so their
// `ring-[3px]` and `rounded-[min(var(--radius-md),10px)]` are upstream's
// choices, not this project's. Listed one by one on purpose: adding a
// component is then a visible decision in a diff, not a widening glob that
// quietly stops covering `src/components/ui/status-badge.tsx` — which is this
// project's own and stays covered.
const EXEMPT = [
  "src/app/globals.css",
  "src/components/ui/badge.tsx",
  "src/components/ui/button.tsx",
  "src/components/ui/card.tsx",
  "src/components/ui/input.tsx",
  "src/components/ui/separator.tsx",
  "src/components/ui/skeleton.tsx",
  "src/components/ui/textarea.tsx",
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return EXTENSIONS.some((extension) => path.endsWith(extension)) ? [path] : [];
  });
}

const files = ROOTS.flatMap(sourceFiles).filter((path) => !EXEMPT.includes(path));

function offences(pattern: RegExp): string[] {
  return files.flatMap((path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line, index) => (pattern.test(line) ? [`${path}:${index + 1} ${line.trim()}`] : [])),
  );
}

describe("design tokens", () => {
  it("scans the files that actually render", () => {
    // Guards the guard: a broken walk would make everything below pass.
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain("src/components/ui/status-badge.tsx");
  });

  it("has no colour literal outside globals.css", () => {
    // Hex, rgb()/rgba(), hsl()/hsla(), and Tailwind's arbitrary colour form.
    expect(
      offences(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(|\[#[0-9a-fA-F]{3,8}\]/),
    ).toEqual([]);
  });

  it("has no pixel value outside globals.css", () => {
    // `[12px]`, `w-[3px]`, and bare `12px` in a style object alike.
    expect(offences(/\b\d+(?:\.\d+)?px\b/)).toEqual([]);
  });
});
