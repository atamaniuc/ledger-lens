import type { AnchorHTMLAttributes, ReactNode } from "react";

// The stories run under @storybook/react-vite, which has no Next.js runtime.
// (The nextjs-vite framework ships a module-alias mock that redirects react
// to next/dist/compiled/react — a directory — which Node's ESM loader on
// Node 22+ rejects, so the vitest story runner cannot load it at all.)
// `next/link` is the only Next module the storied components import; this
// mock renders a plain anchor with the same surface the invoices table uses.
export default function MockLink({
  href,
  children,
  ...props
}: { href: string; children?: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a href={href} {...props}>
      {children}
    </a>
  );
}
