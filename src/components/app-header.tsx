import Link from "next/link";
import { LogoutButton } from "./logout-button";

// The authenticated app shell: navigation, the signed-in identity, and logout.
// Used by the dashboard and the admin page; the login page has no header.
//
// The role comes from the membership the page already resolved, so this
// component never re-queries — the page owns the data, the header renders it.

export function AppHeader({ email }: { email: string }) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-gutter border-b border-border-subtle pb-gutter">
      <div className="flex items-center gap-gutter">
        <span className="text-lg font-semibold text-foreground">LedgerLens</span>
        <nav className="flex items-center gap-snug text-sm">
          <Link
            href="/dashboard"
            className="rounded-control px-snug py-tight text-foreground outline-none hover:bg-surface-sunken focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Dashboard
          </Link>
          <Link
            href="/admin"
            className="rounded-control px-snug py-tight text-muted-foreground outline-none hover:bg-surface-sunken hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Admin
          </Link>
        </nav>
      </div>
      <div className="flex items-center gap-gutter">
        <span data-testid="signed-in-as" className="text-xs text-muted-foreground">
          {email}
        </span>
        <LogoutButton />
      </div>
    </header>
  );
}
