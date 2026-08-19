import { headers } from "next/headers";

/**
 * The correlation id for one dashboard page request.
 *
 * CLAUDE.md: every log line carries one. The ingestion route already mints
 * its own from an inbound `x-correlation-id` or a fresh UUID; this is the
 * same rule applied to the read side, and it is deliberately owned by the
 * *server render* rather than by the client. The render passes it into the
 * Realtime bridge, so a socket that drops twenty minutes later still names
 * the page load that opened it.
 *
 * One id per render, not per component: a page that renders six panels is one
 * request, and six ids would make the log unreadable in exactly the situation
 * it exists for.
 */
export async function pageCorrelationId(): Promise<string> {
  const inbound = (await headers()).get("x-correlation-id");
  return inbound ?? crypto.randomUUID();
}

/** Structured, one line, correlation id first — the same shape the routes emit. */
export function logDashboard(
  correlationId: string,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  console.log(JSON.stringify({ correlation_id: correlationId, event, ...fields }));
}
