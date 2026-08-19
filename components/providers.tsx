"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

// One QueryClient per browser session, created inside a component rather than
// at module scope. A module-level client is shared across every request in a
// server process — one user's cached rows would be handed to the next.

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // The dashboard's own reads happen in Server Components and are
            // pushed by Realtime; what runs through this client is drill-down
            // detail the reader asked for. Refetching it on window focus
            // would spend a round trip to redraw the same drawer.
            refetchOnWindowFocus: false,
            staleTime: 30_000,
            retry: 1,
          },
        },
      }),
  );

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
