import type { EpisodeRow } from "../db/rows.js";

export function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/[’‘]/g, "'").replace(/&amp;/g, "&").replace(/[^a-z0-9]+/g, " ").trim();
}

/** Bigram Dice similarity, for titles that differ by punctuation or a trailing suffix. */
export function titleSimilarity(a: string, b: string): number {
  const grams = (s: string) => {
    const out = new Map<string, number>();
    for (let i = 0; i + 2 <= s.length; i++) { const g = s.slice(i, i + 2); out.set(g, (out.get(g) ?? 0) + 1); }
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  let inter = 0;
  for (const [g, n] of ga) inter += Math.min(n, gb.get(g) ?? 0);
  const total = a.length - 1 + b.length - 1;
  return total <= 0 ? 0 : (2 * inter) / total;
}

/**
 * Exact normalized title, else a long shared prefix, else bigram similarity ≥ 0.85. Near-ties go to `prefer`
 * (for example the episode whose date matches, or the one with a transcript), because feeds sometimes list an episode twice.
 */
export function findEpisodeByTitle(episodes: Iterable<EpisodeRow>, title: string, prefer: (ep: EpisodeRow) => boolean = () => false): EpisodeRow | undefined {
  const key = normalizeTitle(title);
  const scored: { ep: EpisodeRow; sc: number }[] = [];
  for (const ep of episodes) {
    const k = normalizeTitle(ep.title);
    if (k === key) scored.push({ ep, sc: 1.01 });
    else {
      const shorter = Math.min(k.length, key.length);
      const prefix = shorter >= 24 && (k.startsWith(key) || key.startsWith(k));
      scored.push({ ep, sc: prefix ? 1 : titleSimilarity(key, k) });
    }
  }
  scored.sort((a, b) => b.sc - a.sc);
  const best = scored[0];
  if (!best || best.sc < 0.85) return undefined;
  const nearTies = scored.filter((x) => x.sc >= best.sc - 0.03);
  return (nearTies.find((x) => prefer(x.ep)) ?? best).ep;
}
