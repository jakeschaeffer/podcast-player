/** Word-sequence alignment between two transcripts of the same recording. Pure; shared by the transcription eval and ad detection. */

export type Op = "match" | "sub" | "del" | "ins";

/**
 * Banded Levenshtein alignment between a reference (publisher text) and a hypothesis (ASR), with backtrace.
 * The band follows the scaled diagonal, which holds because both sequences follow the same audio.
 */
export function alignTokens(ref: string[], hyp: string[], band = 600): { ops: Op[]; pairs: [number, number][]; sub: number; del: number; ins: number } {
  const n = ref.length;
  const m = hyp.length;
  const width = 2 * band + 1;
  const center = (i: number) => (n === 0 ? 0 : Math.round((i * m) / n));
  const INF = 1 << 29;
  const dist = new Int32Array((n + 1) * width).fill(INF);
  const move = new Uint8Array((n + 1) * width); // 0 diag, 1 up (del ref), 2 left (ins hyp)
  const idx = (i: number, j: number) => i * width + (j - center(i) + band);
  const inBand = (i: number, j: number) => j >= 0 && j <= m && Math.abs(j - center(i)) <= band;
  if (inBand(0, 0)) dist[idx(0, 0)] = 0;
  for (let j = 1; j <= m && inBand(0, j); j++) { dist[idx(0, j)] = j; move[idx(0, j)] = 2; }
  for (let i = 1; i <= n; i++) {
    const lo = Math.max(0, center(i) - band);
    const hi = Math.min(m, center(i) + band);
    for (let j = lo; j <= hi; j++) {
      let best = INF;
      let mv = 1;
      if (inBand(i - 1, j)) { const v = dist[idx(i - 1, j)]! + 1; if (v < best) { best = v; mv = 1; } }
      if (j > 0 && inBand(i, j - 1)) { const v = dist[idx(i, j - 1)]! + 1; if (v < best) { best = v; mv = 2; } }
      if (j > 0 && inBand(i - 1, j - 1)) { const v = dist[idx(i - 1, j - 1)]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1); if (v <= best) { best = v; mv = 0; } }
      dist[idx(i, j)] = best;
      move[idx(i, j)] = mv;
    }
  }
  const ops: Op[] = [];
  const pairs: [number, number][] = [];
  let i = n;
  let j = m;
  let sub = 0, del = 0, ins = 0;
  while (i > 0 || j > 0) {
    const mv = i === 0 ? 2 : j === 0 ? 1 : move[idx(i, j)]!;
    if (mv === 0) {
      if (ref[i - 1] === hyp[j - 1]) { ops.push("match"); pairs.push([i - 1, j - 1]); }
      else { ops.push("sub"); sub++; }
      i--; j--;
    } else if (mv === 1) { ops.push("del"); del++; i--; }
    else { ops.push("ins"); ins++; j--; }
  }
  ops.reverse();
  pairs.reverse();
  return { ops, pairs, sub, del, ins };
}
