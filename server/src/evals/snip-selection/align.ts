import type { NormalizedTranscript } from "../../core/transcript/types.js";

/**
 * Locate a snip's transcript text (produced by another transcriber) inside our word-timed transcript.
 *
 * Method: index the search region's token k-grams, vote for the diagonal offset (region position minus
 * snip position) of every shared k-gram, take the best offset, then chain hits outward from it allowing
 * a few tokens of drift. Boundaries are extrapolated from the first and last chained hit to the snip's
 * first and last token. Robust to casing, punctuation, filler words, and repeated phrases.
 */

export type Alignment = {
  start_word: number;
  /** Exclusive. */
  end_word: number;
  start_ms: number;
  end_ms: number;
  /** Share of snip tokens covered by chained k-gram hits. */
  coverage: number;
  /** Aligned token count over snip token count; near 1 when the transcripts agree. */
  length_ratio: number;
  snip_tokens: number;
  region: { from_word: number; to_word: number };
};

export { normalizeToken, tokenize } from "../../core/transcript/tokens.js";
import { normalizeToken, tokenize } from "../../core/transcript/tokens.js";

type TWord = { idx: number; tok: string; start_ms: number; end_ms: number };

function transcriptTokens(t: NormalizedTranscript): TWord[] {
  const out: TWord[] = [];
  for (const s of t.segments) {
    s.words.forEach((w, i) => {
      const tok = normalizeToken(w[2]);
      if (tok.length > 0) out.push({ idx: s.first_word + i, tok, start_ms: w[0], end_ms: w[1] });
    });
  }
  return out;
}

export type AlignOptions = {
  /** Known start offset of the snip in the episode, if any. */
  start_offset_ms?: number;
  /** Search this far before the offset and after the estimated end. */
  slack_ms?: number;
  /** Speech rate used to estimate the snip's duration from its token count. */
  words_per_second?: number;
  k?: number;
  /** Maximum change in diagonal offset between consecutive accepted hits. */
  max_drift?: number;
};

/** Look for the snip's first (or last) 3 then 2 tokens within ±12 positions of the extrapolated boundary. */
function refine(region: string[], snip: string[], guess: number, side: "start" | "end"): number {
  for (const n of [3, 2]) {
    const probe = side === "start" ? snip.slice(0, n) : snip.slice(-n);
    let best = -1;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let j = Math.max(0, guess - 12); j <= Math.min(region.length - n, guess + 12); j++) {
      const at = side === "start" ? j : j - (n - 1);
      if (at < 0 || at + n > region.length) continue;
      let ok = true;
      for (let d = 0; d < n; d++) if (region[at + d] !== probe[d]) { ok = false; break; }
      if (ok && Math.abs(j - guess) < bestDist) { best = j; bestDist = Math.abs(j - guess); }
    }
    if (best >= 0) return best;
  }
  return guess;
}

export function alignSnip(t: NormalizedTranscript, snipText: string, opts: AlignOptions = {}): Alignment | null {
  const snip = tokenize(snipText);
  const k = opts.k ?? 4;
  if (snip.length < k + 1) return null;
  const all = transcriptTokens(t);
  if (all.length < k) return null;
  const slack = opts.slack_ms ?? 120_000;
  const wps = opts.words_per_second ?? 2.4;
  const maxDrift = opts.max_drift ?? 3;

  const attempt = (region: TWord[]): Alignment | null => {
    if (region.length < k) return null;
    const index = new Map<string, number[]>();
    for (let j = 0; j + k <= region.length; j++) {
      const key = region.slice(j, j + k).map((w) => w.tok).join(" ");
      const list = index.get(key);
      if (list) list.push(j);
      else index.set(key, [j]);
    }
    const hits: { i: number; j: number }[] = [];
    const votes = new Map<number, number>();
    for (let i = 0; i + k <= snip.length; i++) {
      const positions = index.get(snip.slice(i, i + k).join(" "));
      if (!positions || positions.length > 8) continue; // very common k-grams carry no position information
      for (const j of positions) {
        hits.push({ i, j });
        votes.set(j - i, (votes.get(j - i) ?? 0) + 1);
      }
    }
    if (hits.length === 0) return null;
    let bestOffset = 0;
    let bestVotes = -1;
    for (const [offset, n] of votes) if (n > bestVotes || (n === bestVotes && offset < bestOffset)) { bestOffset = offset; bestVotes = n; }
    if (bestVotes < 2) return null;

    // Chain outward from the seed hits along the best diagonal, tolerating gradual drift.
    hits.sort((a, b) => a.i - b.i || a.j - b.j);
    const seedIdx = hits.findIndex((h) => h.j - h.i === bestOffset);
    // Allowed drift grows with the gap since the last accepted hit, because transcriber differences cluster.
    const allowed = (gap: number) => maxDrift + Math.ceil(gap * 0.5);
    const accepted: { i: number; j: number }[] = [];
    let offset = bestOffset;
    let lastI = hits[seedIdx]!.i;
    for (let x = seedIdx; x < hits.length; x++) {
      const h = hits[x]!;
      if (x > seedIdx && h.i <= lastI) continue;
      if (Math.abs(h.j - h.i - offset) <= allowed(h.i - lastI)) { accepted.push(h); offset = h.j - h.i; lastI = h.i; }
    }
    offset = bestOffset;
    lastI = hits[seedIdx]!.i;
    const before: { i: number; j: number }[] = [];
    for (let x = seedIdx - 1; x >= 0; x--) {
      const h = hits[x]!;
      if (h.i >= lastI) continue;
      if (Math.abs(h.j - h.i - offset) <= allowed(lastI - h.i)) { before.push(h); offset = h.j - h.i; lastI = h.i; }
    }
    const chain = [...before.reverse(), ...accepted];
    const first = chain[0]!;
    const last = chain[chain.length - 1]!;
    const covered = new Set<number>();
    for (const h of chain) for (let d = 0; d < k; d++) covered.add(h.i + d);

    // Extrapolate to the snip's first and last token, then prefer an exact short match of those tokens nearby.
    const regionToks = region.map((w) => w.tok);
    const startRegion = refine(regionToks, snip, Math.max(0, first.j - first.i), "start");
    const endRegion = refine(regionToks, snip, Math.min(region.length - 1, last.j + k - 1 + (snip.length - (last.i + k))), "end");
    const startWord = region[startRegion]!;
    const endWord = region[endRegion]!;
    return {
      start_word: startWord.idx,
      end_word: endWord.idx + 1,
      start_ms: startWord.start_ms,
      end_ms: endWord.end_ms,
      coverage: covered.size / snip.length,
      length_ratio: (endRegion - startRegion + 1) / snip.length,
      snip_tokens: snip.length,
      region: { from_word: region[0]!.idx, to_word: region[region.length - 1]!.idx + 1 },
    };
  };

  if (opts.start_offset_ms !== undefined) {
    const from = opts.start_offset_ms - slack;
    const to = opts.start_offset_ms + (snip.length / wps) * 1000 + slack;
    const region = all.filter((w) => w.end_ms >= from && w.start_ms <= to);
    const local = attempt(region);
    if (local && local.coverage >= 0.5) return local;
  }
  return attempt(all);
}
