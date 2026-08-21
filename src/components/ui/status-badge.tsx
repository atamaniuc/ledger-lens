import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ReloadButton } from "@/components/ui/reload-button";
import type { CheckStatus } from "@/features/quality/constants";

// The one place a state becomes a colour.
//
// Six states, not four: `unknown` (the query failed) and `missing` (the check
// never ran) are distinct from `fail`, because conflating them is how a
// dashboard tells a confident lie. Every colour comes from a token — there is
// no hex in this file, which is what makes the grep in `task check` a real
// gate rather than a formality.

export type BadgeState = CheckStatus | "unknown" | "missing";

const STYLES: Record<BadgeState, string> = {
  pass: "bg-status-pass-surface text-status-pass",
  warn: "bg-status-warn-surface text-status-warn",
  fail: "bg-status-fail-surface text-status-fail",
  unknown: "bg-status-unknown-surface text-status-unknown",
  missing: "bg-status-missing-surface text-status-missing",
};

const LABELS: Record<BadgeState, string> = {
  pass: "Pass",
  warn: "Warn",
  fail: "Fail",
  unknown: "Unknown",
  missing: "Not run",
};

export function StatusBadge({
  state,
  label,
  className = "",
}: {
  state: BadgeState;
  label?: string;
  className?: string;
}) {
  return (
    <span
      data-state={state}
      className={`inline-flex items-center rounded-control px-tight py-[0.125rem] text-xs font-medium ${STYLES[state]} ${className}`}
    >
      {label ?? LABELS[state]}
    </span>
  );
}

/**
 * Every panel on the dashboard. A shadcn `Card` underneath, so spacing,
 * radius and ring come from one place — but kept as its own component rather
 * than spelling out `Card`/`CardHeader`/`CardTitle` at eleven call sites,
 * because a panel here always has exactly a title, an optional action and a
 * body, and the wrapper is what keeps that true.
 */
export function Panel({
  title,
  action,
  children,
  testId,
  className,
  ariaLabel,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <Card data-testid={testId} className={className} aria-label={ariaLabel}>
      <CardHeader>
        <CardTitle className="text-sm font-semibold">{title}</CardTitle>
        {action ? <CardAction>{action}</CardAction> : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/**
 * What a panel renders when its own query failed. The page keeps rendering.
 *
 * The error names what failed and — by default — offers the retry that works
 * from a server-rendered panel: a reload, which re-runs the same queries
 * under the same policies. Panels that can retry in place (the lineage
 * drawer) or that keep a working form on screen (the copilot) pass
 * "retry=false" and render their own affordance.
 */
export function PanelError({
  message,
  retry = true,
}: {
  message: string;
  retry?: boolean;
}) {
  return (
    <div
      role="alert"
      data-testid="panel-error"
      className="flex flex-col items-start gap-snug"
    >
      <p className="text-sm text-status-fail">This panel could not load. {message}</p>
      {retry && <ReloadButton />}
    </div>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}
