// Value bounds, enforced here rather than in the published tool schema.
//
// See the note in ./index.ts for why. In short: a provider that validates
// arguments server-side rejects the whole request when a bound is exceeded,
// which ends the turn; enforcing the same bound here turns it into a clamp or
// a tool error the model can act on and try again.

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Throws rather than clamping, because there is no safe correction for a
 * malformed date — guessing what "March" meant would answer a question the
 * user did not ask. The message names the parameter so the model can fix it.
 */
export function isoDate(value: string, parameter: string): string {
  if (!ISO_DATE.test(value)) {
    throw new Error(`${parameter} must be a date in YYYY-MM-DD form, got "${value}"`);
  }
  return value;
}
