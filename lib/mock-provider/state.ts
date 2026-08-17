// In-memory request counters driving rateLimit/serverError/expiredToken
// chaos. Deliberately not persisted — the mock provider itself is a
// stand-in for a third-party API, not a system under test; per-process
// memory is enough for local dev and CI runs (.claude/PRD.md "Mock
// Provider" non-goal: "Real persistence").
let requestCount = 0;
const tokenRequestCounts = new Map<string, number>();

export function nextRequestCount(): number {
  requestCount += 1;
  return requestCount;
}

export function nextTokenRequestCount(token: string): number {
  const count = (tokenRequestCounts.get(token) ?? 0) + 1;
  tokenRequestCounts.set(token, count);
  return count;
}

// Exposed for tests that need a clean sequence for a given seed.
export function resetMockProviderState(): void {
  requestCount = 0;
  tokenRequestCounts.clear();
}
