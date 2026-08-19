// Freshness: how long ago the pipeline last ingested anything, and whether
// that is acceptable. Pure arithmetic, kept apart from the query that feeds
// it so the boundary can be tested without a database.

/**
 * Data older than this is stale. Two hours, matching the PRD's US-03.
 *
 * Not read from the database on purpose: Stage 3's `freshness` check applies
 * its own threshold inside `run_data_quality_checks`, and that check answers
 * a different question — whether the *run* passed. This one answers whether
 * what the reader is looking at right now can be trusted. Two thresholds
 * that happen to be similar, not one duplicated.
 */
export const FRESHNESS_THRESHOLD_MS = 2 * 60 * 60 * 1000;

export type Freshness =
  /** Ingested within the threshold. `ageMs` is how long ago. */
  | { state: "fresh"; ingestedAt: Date; ageMs: number }
  /** Ingested, but longer ago than the threshold. */
  | { state: "stale"; ingestedAt: Date; ageMs: number }
  /** The org has never ingested anything. Not a failure — a new tenant. */
  | { state: "empty" }
  /** The query failed. Never rendered as fresh; see ADR 0007's amendment. */
  | { state: "unknown" };

/**
 * Classify the newest `raw_events.ingested_at` for an org.
 *
 * `null` means the org has no rows at all, which is "empty" rather than
 * "stale": telling a tenant who has not ingested yet that their data is out
 * of date is a false alarm, and the empty state names the next action.
 *
 * An unparseable timestamp is `unknown`, not `fresh`. There is deliberately
 * no input that produces `fresh` by default — the PRD's counter-metric is
 * that a false green is worse than no signal.
 */
export function classifyFreshness(
  ingestedAt: string | Date | null,
  now: Date = new Date(),
  thresholdMs: number = FRESHNESS_THRESHOLD_MS,
): Freshness {
  if (ingestedAt === null) return { state: "empty" };

  const at = ingestedAt instanceof Date ? ingestedAt : new Date(ingestedAt);
  if (Number.isNaN(at.getTime())) return { state: "unknown" };

  const ageMs = now.getTime() - at.getTime();
  // Exactly at the threshold counts as fresh; the boundary has to fall on one
  // side and a badge that flips a millisecond early helps nobody.
  return ageMs <= thresholdMs
    ? { state: "fresh", ingestedAt: at, ageMs }
    : { state: "stale", ingestedAt: at, ageMs };
}

/** "3 minutes ago" / "4 hours ago". Coarse on purpose — this is a badge. */
export function formatAge(ageMs: number): string {
  // A clock skew between the browser and Postgres can make this negative.
  // "in 3 minutes" would look like a bug; "just now" is what it means.
  if (ageMs < 60_000) return "just now";

  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
