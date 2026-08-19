"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { LineagePayload } from "@/lib/dashboard/queries";

// Which figure the reader has selected, and what it was built from.
//
// Selection only. This context fetches nothing: the lineage payload — the run
// ids and raw event ids behind a figure — is computed during the server
// render and carried here, so clicking a tile costs no round trip. The drawer
// that opens then fetches the raw rows under the user's own JWT.
//
// Split from the panels for one reason: `MetricTiles` and `InvoicesTable` are
// Server Components. Selection is client state, and putting it inside either
// of them would drag the whole panel across the boundary.

export interface Selection {
  /** What was clicked, for the drawer's heading. */
  label: string;
  lineage: LineagePayload;
}

interface SelectionContextValue {
  selection: Selection | null;
  select: (selection: Selection) => void;
  clear: () => void;
}

const SelectionContext = createContext<SelectionContextValue>({
  selection: null,
  select: () => {},
  clear: () => {},
});

export function useSelection(): SelectionContextValue {
  return useContext(SelectionContext);
}

export function SelectionProvider({ children }: { children: React.ReactNode }) {
  const [selection, setSelection] = useState<Selection | null>(null);

  const select = useCallback((next: Selection) => setSelection(next), []);
  const clear = useCallback(() => setSelection(null), []);

  const value = useMemo(
    () => ({ selection, select, clear }),
    [selection, select, clear],
  );

  return (
    <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>
  );
}

/**
 * The click target a Server Component wraps a figure in.
 *
 * A Server Component cannot hold an onClick, so this is the smallest possible
 * client island: it takes the payload the server already computed and puts it
 * into the context. The figure itself stays server-rendered.
 */
export function SelectTrigger({
  label,
  lineage,
  children,
  className,
}: {
  label: string;
  lineage: LineagePayload;
  children: React.ReactNode;
  className?: string;
}) {
  const { selection, select, clear } = useSelection();
  const isSelected = selection?.label === label;

  return (
    <button
      type="button"
      aria-pressed={isSelected}
      data-selected={isSelected || undefined}
      onClick={() => (isSelected ? clear() : select({ label, lineage }))}
      className={className}
    >
      {children}
    </button>
  );
}
