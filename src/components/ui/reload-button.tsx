"use client";

import { Button } from "@/components/ui/button";

// The one retry affordance that works from a server-rendered panel: a page
// reload re-runs the same queries under the same policies. Panels that can
// retry in place (the lineage drawer) render their own button instead.
export function ReloadButton({ label = "Try again" }: { label?: string }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-testid="panel-retry"
      onClick={() => window.location.reload()}
    >
      {label}
    </Button>
  );
}
