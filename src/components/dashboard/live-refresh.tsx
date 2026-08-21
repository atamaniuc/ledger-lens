"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  DASHBOARD_CHANNEL,
  REFRESH_COALESCE_MS,
  SUBSCRIBED_TABLES,
} from "@/features/dashboard/realtime";
import { createClient } from "@/platform/supabase/browser-client";

// The single Realtime subscriber on the page, and the bridge from what it
// hears to what the reader sees.
//
// The figures on this page are rendered by Server Components, so there is no
// client cache to invalidate — an earlier draft of the design said there was,
// and it would have left the tiles stale behind a live-looking panel, which
// is the false-green failure the whole design exists to avoid. What the
// bridge does instead is call `router.refresh()`, which re-runs the same
// server queries through the same policies.
//
// One subscriber, owned here. `PipelineStatusLive` consumes this context and
// opens no channel of its own: two channels would mean two places declaring
// which tables and events are in scope, and only one of them under test.

export type LiveState = "connecting" | "live" | "degraded";

interface LiveContextValue {
  state: LiveState;
  /** Bumped on every coalesced refresh, so consumers can show "just updated". */
  refreshCount: number;
}

const LiveContext = createContext<LiveContextValue>({
  state: "connecting",
  refreshCount: 0,
});

export function useLive(): LiveContextValue {
  return useContext(LiveContext);
}

export function LiveRefreshProvider({
  children,
  correlationId,
}: {
  children: React.ReactNode;
  /**
   * The id the server render used. Carrying it into the client means a
   * disconnect here can be traced to the page load that opened the socket —
   * every log line in this project carries one (CLAUDE.md).
   */
  correlationId: string;
}) {
  const router = useRouter();
  const [state, setState] = useState<LiveState>("connecting");
  const [refreshCount, setRefreshCount] = useState(0);

  // Refs, not state: changing these must not re-render, and the effect below
  // must not re-subscribe when they change.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The server mints a fresh correlation id on every render, and
  // `router.refresh()` is a render — so depending on the prop directly would
  // tear down and re-open the channel after every refresh the channel itself
  // triggered. Events landing in that gap would be lost, and the loop would
  // be invisible because everything still looks connected. Held in a ref so
  // the log line stays current while the subscription stays put.
  const correlation = useRef(correlationId);
  useEffect(() => {
    correlation.current = correlationId;
  }, [correlationId]);
  // A disconnect logs once, not once per retry. Realtime retries on a backoff
  // and a flapping connection would otherwise fill the console with the same
  // line, which is how a real signal gets ignored.
  const reportedDown = useRef(false);

  const scheduleRefresh = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      router.refresh();
      setRefreshCount((n) => n + 1);
    }, REFRESH_COALESCE_MS);
  }, [router]);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    const start = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (cancelled) return;

      // Before subscribing, always. Without it Realtime evaluates the
      // policies as the anonymous role and the subscription silently returns
      // nothing — a live panel that is simply never told anything.
      if (session?.access_token) {
        await supabase.realtime.setAuth(session.access_token);
      }

      const channel = supabase.channel(DASHBOARD_CHANNEL);

      for (const { table, events } of SUBSCRIBED_TABLES) {
        for (const event of events) {
          channel.on(
            "postgres_changes",
            { event, schema: "public", table },
            scheduleRefresh,
          );
        }
      }

      channel.subscribe((status) => {
        if (cancelled) return;

        if (status === "SUBSCRIBED") {
          setState("live");
          reportedDown.current = false;
          return;
        }

        // CHANNEL_ERROR, TIMED_OUT, CLOSED. Say so in the UI: a frozen panel
        // that still looks live is the same false-green failure in a
        // different costume.
        setState("degraded");
        if (!reportedDown.current) {
          reportedDown.current = true;
          console.warn("[dashboard] realtime degraded", {
            correlation_id: correlation.current,
            status,
          });
        }
      });

      return channel;
    };

    const pending = start();

    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
      void pending.then((channel) => {
        if (channel) void supabase.removeChannel(channel);
      });
    };
  }, [scheduleRefresh]);

  const value = useMemo(() => ({ state, refreshCount }), [state, refreshCount]);

  return (
    <LiveContext.Provider value={value}>
      {/* The state, in the DOM. A test that inserts a row before the channel
          reaches SUBSCRIBED is testing nothing, so it needs something to wait
          on that is not a timeout. */}
      <div data-testid="live-state" data-live={state} className="contents">
        {children}
      </div>
    </LiveContext.Provider>
  );
}
