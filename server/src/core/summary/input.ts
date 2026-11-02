/**
 * What a snip summary is given: the excerpt as sentences with ids, and a little context before it. The ids are
 * positions in the excerpt (0, 1, 2…), which is what the model cites and the validator checks, so a port of the
 * summary step must build them exactly this way (contracts/golden/summary).
 */
import { sentencize, type Sentence } from "../snip/sentencize.js";
import { sliceWords } from "../transcript/normalize.js";
import type { NormalizedTranscript } from "../transcript/types.js";

/** Sentences covering exactly `[start_word, end_word)`, clipped at both ends and renumbered from 0. */
export function sentencesForRange(t: NormalizedTranscript, start_word: number, end_word: number): Sentence[] {
  const words = sliceWords(t, start_word, end_word);
  if (words.length === 0) return [];
  const raw = sentencize(t, { from_ms: words[0]![0], to_ms: words[words.length - 1]![1] + 1 });
  const out: Sentence[] = [];
  for (const s of raw) {
    const sw = Math.max(s.start_word, start_word);
    const ew = Math.min(s.end_word, end_word);
    if (sw >= ew) continue;
    const ws = sliceWords(t, sw, ew);
    out.push({ id: out.length, speaker: s.speaker, start_word: sw, end_word: ew, start_ms: ws[0]![0], end_ms: ws[ws.length - 1]![1], text: ws.map((w) => w[2]).join(" "), word_count: ws.length });
  }
  return out;
}

export function precedingSentences(t: NormalizedTranscript, start_word: number, n: number): Sentence[] {
  if (start_word === 0) return [];
  const before = sliceWords(t, Math.max(0, start_word - 80), start_word);
  if (before.length === 0) return [];
  const all = sentencize(t, { from_ms: before[0]![0], to_ms: before[before.length - 1]![1] + 1 });
  return all.filter((s) => s.end_word <= start_word).slice(-n);
}
