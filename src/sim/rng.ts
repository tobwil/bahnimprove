/** Deterministischer Zufall: gleicher Tag → gleiche Störungen, damit Gegenrechnungen vergleichbar sind. */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (min: number, max: number) => min + next() * (max - min),
    int: (min: number, max: number) => Math.floor(min + next() * (max - min + 1)),
    chance: (p: number) => next() < p,
    /** Exponentialverteilt mit Mittelwert `mean`. */
    exp: (mean: number) => -Math.log(1 - next()) * mean,
    pickWeighted<T>(items: T[], weight: (t: T) => number): T {
      const total = items.reduce((s, i) => s + weight(i), 0);
      let r = next() * total;
      for (const i of items) {
        r -= weight(i);
        if (r <= 0) return i;
      }
      return items[items.length - 1];
    },
  };
}

export type Rng = ReturnType<typeof rng>;
