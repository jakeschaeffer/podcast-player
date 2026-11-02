/**
 * YouTube captions as a transcript (docs/video-plan.md). The home fetcher uploads a video's captions in YouTube's
 * `json3` form: a list of events, each a line shown at `tStartMs` for `dDurationMs`, made of segments. Automatic
 * captions give one segment per word with its offset from the line's start, so every word has its own time;
 * captions the creator uploaded give a whole line as one segment, so its words share the line's time evenly by
 * length. Either way the result is a RawTranscript like a transcription provider's, with no speakers.
 * Pure: no I/O.
 */
import type { RawTranscript, RawWord } from "./types.js";

export type Json3 = {
  events?: { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string; tOffsetMs?: number; acAsrConf?: number }[] }[];
};

export type CaptionsMeta = {
  /** `auto` for YouTube's automatic captions, `manual` for ones the creator uploaded. */
  kind: "auto" | "manual";
  /** The track's language code, e.g. `en`. */
  language: string | null;
};

/** A word may not be shown longer than this after it starts, however long the line stays up. */
const WORD_MAX_MS = 2_000;

export function captionsToTranscript(json: Json3, meta: CaptionsMeta): RawTranscript {
  const timed: { text: string; start_ms: number; end_ms: number; confidence?: number }[] = [];
  for (const event of json.events ?? []) {
    const segs = event.segs ?? [];
    const lineStart = Math.max(0, Math.round(event.tStartMs ?? 0));
    const lineEnd = lineStart + Math.max(0, Math.round(event.dDurationMs ?? 0));
    const pieces = segs
      .map((s, i) => ({ text: (s.utf8 ?? "").trim(), start: lineStart + Math.max(0, Math.round(s.tOffsetMs ?? 0)), conf: s.acAsrConf, i }))
      .filter((p) => p.text.length > 0);
    pieces.forEach((p, n) => {
      const next = pieces[n + 1];
      const pieceEnd = next ? next.start : lineEnd;
      const words = p.text.split(/\s+/).filter(Boolean);
      // One segment per word (automatic captions): the word's own time. Several words in one segment (a line the
      // creator wrote): share its time by character count, so a long word takes longer than a short one.
      const chars = words.reduce((n, w) => n + w.length, 0) || 1;
      let at = p.start;
      const span = Math.max(0, pieceEnd - p.start);
      for (const w of words) {
        const share = words.length === 1 ? span : Math.round((span * w.length) / chars);
        timed.push({ text: w, start_ms: at, end_ms: at + share, ...(p.conf !== undefined ? { confidence: p.conf / 100 } : {}) });
        at += share;
      }
    });
  }
  // Times must not run backwards, and a word ends where the next starts (or soon after it starts, when the next word
  // is far off), never after the line that showed it.
  timed.sort((a, b) => a.start_ms - b.start_ms);
  const words: RawWord[] = timed.map((w, i) => {
    const next = timed[i + 1];
    const upper = Math.min(w.end_ms > w.start_ms ? w.end_ms : w.start_ms + WORD_MAX_MS, w.start_ms + WORD_MAX_MS);
    const end = next ? Math.min(next.start_ms, upper) : upper;
    return { text: w.text, start_ms: w.start_ms, end_ms: Math.max(end, w.start_ms + 1), ...(w.confidence !== undefined ? { confidence: w.confidence } : {}) };
  });
  return { provider: "youtube", model: meta.kind === "auto" ? "captions-auto" : "captions", language: meta.language, words, events: [] };
}
