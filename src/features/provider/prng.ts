// Deterministic PRNG (mulberry32) so the mock provider's chaos is
// reproducible under a fixed seed — same seed, same failure sequence,
// usable as a regression fixture (CLAUDE.md PRD: Mock Provider, US-02).
export function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return function next() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
