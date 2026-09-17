/**
 * Deterministic PRNG (mulberry32) so terrain/scatter results are reproducible across runs
 * for the same seed — `Math.random()` can't be seeded, and `SimplexNoise`/`MeshSurfaceSampler`
 * both accept a custom `{ random(): number }`/random-function source instead.
 */
export const createSeededRandom = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
