import { endsSentence } from "../transcript/normalize.js";
import type { NormalizedTranscript, WordTuple } from "../transcript/types.js";

/** Version of the sentence rules; evals and the model prompt depend on it. */
export const SENTENCIZER_VERSION = "sentencizer_v1";

export type Sentence = {
  /** Position in the returned list, used as the id a model may pick. */
  id: number;
  speaker: string | null;
  /** Global word range `[start_word, end_word)`. */
  start_word: number;
  end_word: number;
  start_ms: number;
  end_ms: number;
  text: string;
  word_count: number;
};

export type SentencizeOptions = {
  /** Only words with `end_ms > from_ms` are considered. */
  from_ms?: number;
  /** Only words with `start_ms < to_ms` are considered. */
  to_ms?: number;
  pause_split_ms?: number;
  /** Same-speaker fragments shorter than this merge into their predecessor. */
  min_words?: number;
};

type FlatWord = { index: number; speaker: string | null; w: WordTuple };

const MARGIN_MS = 120_000;

/**
 * Split a transcript (or a time range of it) into sentences, deterministically:
 * a new sentence starts on a speaker change, on a pause of 700 ms or more, or after a word that ends
 * a sentence. Same-speaker fragments shorter than `min_words` are merged into their predecessor;
 * a short interjection by another speaker stays separate because it matters for boundary choice.
 */
export function sentencize(t: NormalizedTranscript, opts: SentencizeOptions = {}): Sentence[] {
  const pause = opts.pause_split_ms ?? 700;
  const minWords = opts.min_words ?? 3;
  const from = opts.from_ms ?? Number.NEGATIVE_INFINITY;
  const to = opts.to_ms ?? Number.POSITIVE_INFINITY;

  // Sentencize a margin around the requested range so a boundary never cuts a sentence into a
  // fragment, then keep only the sentences that overlap the range.
  const lo = from - MARGIN_MS;
  const hi = to + MARGIN_MS;
  const flat: FlatWord[] = [];
  for (const s of t.segments) {
    if (s.end_ms <= lo || s.start_ms >= hi) continue;
    s.words.forEach((w, i) => {
      if (w[1] > lo && w[0] < hi) flat.push({ index: s.first_word + i, speaker: s.speaker, w });
    });
  }

  const groups: FlatWord[][] = [];
  let current: FlatWord[] = [];
  for (let i = 0; i < flat.length; i++) {
    const fw = flat[i]!;
    const prev = flat[i - 1];
    const startNew =
      prev !== undefined &&
      (fw.speaker !== prev.speaker || fw.w[0] - prev.w[1] >= pause || endsSentence(prev.w[2]) || fw.index !== prev.index + 1);
    if (startNew && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(fw);
  }
  if (current.length > 0) groups.push(current);

  // Merge short same-speaker fragments backwards when they are contiguous and not separated by a long pause.
  const merged: FlatWord[][] = [];
  for (const g of groups) {
    const last = merged[merged.length - 1];
    if (
      last !== undefined &&
      g.length < minWords &&
      g[0]!.speaker === last[0]!.speaker &&
      g[0]!.index === last[last.length - 1]!.index + 1 &&
      g[0]!.w[0] - last[last.length - 1]!.w[1] < pause
    ) {
      last.push(...g);
    } else {
      merged.push([...g]);
    }
  }

  const inRange = merged.filter((g) => g[g.length - 1]!.w[1] > from && g[0]!.w[0] < to);
  return inRange.map((g, id) => {
    const first = g[0]!;
    const last = g[g.length - 1]!;
    return {
      id,
      speaker: first.speaker,
      start_word: first.index,
      end_word: last.index + 1,
      start_ms: first.w[0],
      end_ms: last.w[1],
      text: g.map((x) => x.w[2]).join(" "),
      word_count: g.length,
    };
  });
}
