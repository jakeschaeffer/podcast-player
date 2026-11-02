import type { EventTuple, NormalizedTranscript, RawTranscript, RawWord, Segment, WordTuple } from "./types.js";

export type NormalizeOptions = {
  /** A silence at least this long starts a new segment. */
  pause_split_ms: number;
  /** Once a segment has this many words, the next sentence end closes it. */
  soft_cap_words: number;
  /** A segment never exceeds this many words. */
  hard_cap_words: number;
  /** When known, no word may end after this. */
  duration_ms?: number;
  /** Relabel provider speaker ids to S1, S2… (default). False keeps the labels given, e.g. names from publisher text. */
  relabel_speakers?: boolean;
};

export const DEFAULT_NORMALIZE_OPTIONS: NormalizeOptions = {
  pause_split_ms: 700,
  soft_cap_words: 40,
  hard_cap_words: 60,
};

/** Version of the segmentation rules; recorded alongside evals so results stay comparable. */
export const NORMALIZER_VERSION = "normalize_v1";

const SENTENCE_END = /[.!?…][’'")\]]*$/u;

export function endsSentence(text: string): boolean {
  return SENTENCE_END.test(text);
}

/**
 * Turn a provider's raw words into the immutable segment form.
 *
 * Pure and deterministic: the same input always yields the same output. Rules, in order:
 * 1. Drop empty tokens and tokens without finite timings; round timings to integer milliseconds.
 * 2. Order words by start time (stable), then clamp so no word starts before the previous one ends
 *    and no word ends before it starts or after the asset's duration.
 * 3. Relabel speakers S1, S2… in order of first appearance; a transcript without speakers has null.
 * 4. Start a new segment on a speaker change, on a pause of `pause_split_ms` or more, when the segment
 *    reached `hard_cap_words`, or when it reached `soft_cap_words` and the previous word ended a sentence.
 * 5. Assign global word indices in that order, once.
 */
export function normalize(raw: RawTranscript, options: Partial<NormalizeOptions> = {}): NormalizedTranscript {
  const opts: NormalizeOptions = { ...DEFAULT_NORMALIZE_OPTIONS, ...stripUndefined(options) };
  if (opts.soft_cap_words < 1 || opts.hard_cap_words < opts.soft_cap_words) {
    throw new Error("normalize: require 1 <= soft_cap_words <= hard_cap_words");
  }

  const words = cleanWords(raw.words, opts.duration_ms);
  const speakerOf = opts.relabel_speakers === false ? (label: string | undefined) => (label === undefined || label === "" ? null : label) : speakerRelabeler();
  const segments: Segment[] = [];
  let current: Segment | null = null;
  let previous: RawWord | null = null;

  for (const w of words) {
    const speaker = speakerOf(w.speaker);
    const startNew =
      current === null ||
      previous === null ||
      speaker !== current.speaker ||
      w.start_ms - previous.end_ms >= opts.pause_split_ms ||
      current.words.length >= opts.hard_cap_words ||
      (current.words.length >= opts.soft_cap_words && endsSentence(previous.text));

    if (startNew || current === null) {
      current = {
        idx: segments.length,
        start_ms: w.start_ms,
        end_ms: w.end_ms,
        speaker,
        first_word: previous === null ? 0 : segments.reduce((n, s) => n + s.words.length, 0),
        text: "",
        words: [],
      };
      segments.push(current);
    }
    const tuple: WordTuple = [w.start_ms, w.end_ms, w.text];
    current.words.push(tuple);
    current.end_ms = w.end_ms;
    previous = w;
  }

  for (const s of segments) s.text = s.words.map((t) => t[2]).join(" ");

  const events: EventTuple[] = raw.events
    .filter((e) => e.label.trim().length > 0 && Number.isFinite(e.start_ms) && Number.isFinite(e.end_ms))
    .map((e) => [Math.round(e.start_ms), Math.max(Math.round(e.start_ms), Math.round(e.end_ms)), e.label.trim()] as EventTuple)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  return {
    provider: raw.provider,
    model: raw.model,
    language: raw.language,
    word_count: words.length,
    segments,
    events,
  };
}

function cleanWords(input: RawWord[], duration_ms: number | undefined): RawWord[] {
  const words: RawWord[] = [];
  for (const w of input) {
    const text = w.text.trim();
    if (text.length === 0 || !Number.isFinite(w.start_ms) || !Number.isFinite(w.end_ms)) continue;
    const next: RawWord = { text, start_ms: Math.round(w.start_ms), end_ms: Math.round(w.end_ms) };
    if (w.speaker !== undefined) next.speaker = w.speaker;
    if (w.confidence !== undefined) next.confidence = w.confidence;
    words.push(next);
  }
  // Array.prototype.sort is stable, so equal start times keep provider order.
  words.sort((a, b) => a.start_ms - b.start_ms);
  let previousEnd = 0;
  for (const w of words) {
    if (w.start_ms < previousEnd) w.start_ms = previousEnd;
    if (w.end_ms < w.start_ms) w.end_ms = w.start_ms;
    if (duration_ms !== undefined) {
      if (w.start_ms > duration_ms) w.start_ms = duration_ms;
      if (w.end_ms > duration_ms) w.end_ms = duration_ms;
    }
    previousEnd = w.end_ms;
  }
  return words;
}

function speakerRelabeler(): (label: string | undefined) => string | null {
  const map = new Map<string, string>();
  return (label) => {
    if (label === undefined || label === "") return null;
    let out = map.get(label);
    if (out === undefined) {
      out = `S${map.size + 1}`;
      map.set(label, out);
    }
    return out;
  };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

/** Words of `t` with global index in `[start_word, end_word)`, in order. Used to materialize snip excerpts. */
export function sliceWords(t: NormalizedTranscript, start_word: number, end_word: number): WordTuple[] {
  if (!(start_word >= 0 && end_word <= t.word_count && start_word <= end_word)) {
    throw new RangeError(`sliceWords: [${start_word}, ${end_word}) outside 0..${t.word_count}`);
  }
  const out: WordTuple[] = [];
  for (const s of t.segments) {
    const segEnd = s.first_word + s.words.length;
    if (segEnd <= start_word) continue;
    if (s.first_word >= end_word) break;
    const from = Math.max(0, start_word - s.first_word);
    const to = Math.min(s.words.length, end_word - s.first_word);
    for (let i = from; i < to; i++) out.push(s.words[i]!);
  }
  return out;
}

/** One speaker's run of words inside a range, for showing who said what. */
export type SpeakerTurn = { speaker: string | null; text: string };

/**
 * The words in `[start_word, end_word)` grouped into turns: consecutive segments by the same speaker run together, and
 * a new turn starts where the speaker changes. Without speaker labels the whole range is one turn.
 */
export function speakerTurns(t: NormalizedTranscript, start_word: number, end_word: number): SpeakerTurn[] {
  const turns: SpeakerTurn[] = [];
  for (const s of t.segments) {
    const segEnd = s.first_word + s.words.length;
    if (segEnd <= start_word) continue;
    if (s.first_word >= end_word) break;
    const words = s.words.slice(Math.max(0, start_word - s.first_word), Math.min(s.words.length, end_word - s.first_word)).map((w) => w[2]);
    if (words.length === 0) continue;
    const last = turns[turns.length - 1];
    if (last && last.speaker === s.speaker) last.text += ` ${words.join(" ")}`;
    else turns.push({ speaker: s.speaker, text: words.join(" ") });
  }
  return turns;
}
