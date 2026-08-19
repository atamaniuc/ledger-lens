import type { CheckStatus } from "@/lib/data-quality/constants";

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

export function Panel({
  title,
  action,
  children,
  testId,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <section
      data-testid={testId}
      className="rounded-panel border border-border-subtle bg-surface p-section"
    >
      <header className="mb-gutter flex items-baseline justify-between gap-gutter">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}

/** What a panel renders when its own query failed. The page keeps rendering. */
export function PanelError({ message }: { message: string }) {
  return (
    <p role="alert" data-testid="panel-error" className="text-sm text-status-fail">
      This panel could not load. {message}
    </p>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted">{children}</p>;
}
