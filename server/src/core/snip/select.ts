import type { NormalizedTranscript, WordTuple } from "../transcript/types.js";
import { sliceWords } from "../transcript/normalize.js";
import { sentencize, type Sentence } from "./sentencize.js";

/**
 * Version of the selection rules; recorded on every revision.
 * v2 (October 21, 2026): the end is the latest eligible sentence; the default start is the sentence start
 * nearest `target_ms` back; scored signals only break ties inside `snap_band_ms`; the model, when present,
 * may only move the start among a few candidate sentences around the default. Measured against the owner's
 * Readwise snips, this beat the v1 scored heuristic 34% to 13% on "no edit needed".
 *
 * November 10, 2026: a picker may ask for reach (`SpanPicker.reach_ms`) and is then offered every sentence start
 * back to it. The rules themselves, and so everything chosen without a model, are as they were: still v2.
 */
export const SELECTOR_VERSION = "select_v2";

/**
 * How far before the tap a start picker with reach may place the start. On the 17 snips the owner had re-cut by
 * November 9, 2026, the start they chose was among the picker's candidates for 5 with the few sentences around the
 * default, for 13 with every start in the rules' 180 s, and for 16 with every start in 240 s; 300 s added none.
 */
export const WIDE_REACH_MS = 240_000;

export type SelectPrefs = {
  min_ms: number;
  max_ms: number;
  /** Preferred distance from the end back to the start. */
  target_ms: number;
  lead_pad_ms: number;
  tail_pad_ms: number;
  /** How many of the latest sentence ends are eligible (the first is used; the rest are kept for the record). */
  end_candidates: number;
  /** Candidates whose distance from the target is within this of the nearest candidate's distance are scored; 0 means pure snap. */
  snap_band_ms: number;
  /** The model may move the start this many sentences before or after the default. */
  model_start_radius: number;
  /** Durations inside this range earn the "good length" point when scoring is active. */
  good_min_ms: number;
  good_max_ms: number;
};

export const DEFAULT_SELECT_PREFS: SelectPrefs = {
  min_ms: 30_000,
  max_ms: 180_000,
  target_ms: 90_000,
  lead_pad_ms: 200,
  tail_pad_ms: 250,
  end_candidates: 3,
  snap_band_ms: 0,
  model_start_radius: 3,
  good_min_ms: 60_000,
  good_max_ms: 150_000,
};

export type SelectMethod = "model" | "snap" | "heuristic" | "fixed";

export type ScoredCandidate = {
  start_id: number;
  end_id: number;
  duration_ms: number;
  /** Distance of the duration from the target. */
  distance_ms: number;
  score: number;
  reasons: string[];
};

export type Selection = {
  start_ms: number;
  end_ms: number;
  start_word: number | null;
  end_word: number | null;
  method: SelectMethod;
  /** `reach_lo_ms` is set when a picker with reach was offered starts from before `lo_ms`, back to there. */
  window: { lo_ms: number; hi_ms: number; short_exception: boolean; min_relaxed: boolean; reach_lo_ms?: number };
  /** Sentences the selector saw, with a few before the window for context (`eligible` false). */
  sentences: (Sentence & { eligible: boolean })[];
  eligible_end_ids: number[];
  /** Valid starts for the chosen end, nearest the target first. */
  candidates: ScoredCandidate[];
  /** The deterministic choice, before any model adjustment. */
  snap: { start_id: number; end_id: number } | null;
  chosen: { start_id: number; end_id: number; reason: string } | null;
  model_rejection: string | null;
  version: string;
};

/**
 * The model's only job in v2: pick the start sentence among the candidates offered. The end is fixed. A picker that
 * names a reach is offered every whole-sentence start back to that far before the tap, which may be further than the
 * rules look (never before the listener began hearing); one that names none gets the few sentences around the default.
 */
export type SpanPicker = ((input: {
  sentences: (Sentence & { eligible: boolean })[];
  end_id: number;
  snap_start_id: number;
  candidate_start_ids: number[];
  anchor_ms: number;
  prefs: SelectPrefs;
  short_exception: boolean;
}) => Promise<{ start_id: number; reason: string } | null>) & { reach_ms?: number };

export type SelectInput = {
  transcript: NormalizedTranscript | null;
  anchor_ms: number;
  heard_from_ms: number;
  duration_ms: number;
  prefs?: Partial<SelectPrefs>;
  picker?: SpanPicker;
};

const FRAMING = /^(so\b|the thing is|here'?s|what i (found|learned|realized|think)|i think the|the way i|one thing|let me|the reason|the key|the problem|the question|the point|if you)/i;
const CONTINUATION = /^(and|but|because|which|or|also|then|it|he|she|they|that|this|these|those)\b/i;
const CONTEXT_MS = 60_000;

/**
 * Choose the span for a tap at `anchor_ms`. See docs/core/02-snip-selection.md.
 * Pure apart from the optional picker; deterministic without it.
 */
export async function selectSpan(input: SelectInput): Promise<Selection> {
  const prefs: SelectPrefs = { ...DEFAULT_SELECT_PREFS, ...input.prefs };
  const T = clamp(Math.round(input.anchor_ms), 0, input.duration_ms);
  const H = clamp(Math.round(input.heard_from_ms), 0, T);
  const lo = Math.max(0, T - prefs.max_ms, H);
  const hi = T;
  const short_exception = hi - lo < prefs.min_ms;
  // A picker with reach is shown, and may choose from, sentences from before the window the rules look in.
  const reach = input.picker?.reach_ms;
  const reachLo = reach === undefined ? lo : Math.min(lo, Math.max(0, T - reach, H));
  const window: Selection["window"] = { lo_ms: lo, hi_ms: hi, short_exception, min_relaxed: false, ...(reachLo < lo ? { reach_lo_ms: reachLo } : {}) };
  const empty = { sentences: [] as Selection["sentences"], eligible_end_ids: [] as number[], candidates: [] as ScoredCandidate[], snap: null, chosen: null, model_rejection: null, window, version: SELECTOR_VERSION };

  if (!input.transcript || hi <= lo) return { ...fixedSpan(input.transcript, lo, hi, prefs), ...empty };

  const all = sentencize(input.transcript, { from_ms: Math.max(0, reachLo - CONTEXT_MS), to_ms: hi });
  const sentences = all.map((s) => ({ ...s, eligible: s.start_ms >= lo && s.end_ms <= hi }));
  const eligible = sentences.filter((s) => s.eligible);
  if (eligible.length === 0) return { ...fixedSpan(input.transcript, lo, hi, prefs), ...empty, sentences };

  const eligible_end_ids = chooseEnds(eligible, prefs.end_candidates);
  const endId = eligible_end_ids[0]!;
  // When no sentence-aligned span can reach the minimum, a shorter whole-sentence span beats a mid-sentence cut.
  let candidates = startCandidates(sentences, endId, prefs, short_exception);
  if (candidates.length === 0 && !short_exception) {
    candidates = startCandidates(sentences, endId, prefs, true);
    window.min_relaxed = candidates.length > 0;
  }
  if (candidates.length === 0) return { ...fixedSpan(input.transcript, lo, hi, prefs), ...empty, sentences, eligible_end_ids };

  const snapCandidate = candidates[0]!;
  const snap = { start_id: snapCandidate.start_id, end_id: endId };
  let chosen: Selection["chosen"] = { ...snap, reason: snapCandidate.reasons.join(", ") || "nearest target" };
  let method: SelectMethod = prefs.snap_band_ms > 0 ? "heuristic" : "snap";
  let model_rejection: string | null = null;

  if (input.picker) {
    const byId = [...candidates].sort((a, b) => a.start_id - b.start_id);
    const pos = byId.findIndex((c) => c.start_id === snap.start_id);
    const offered =
      reach === undefined
        ? byId.slice(Math.max(0, pos - prefs.model_start_radius), pos + prefs.model_start_radius + 1).map((c) => c.start_id)
        : startsWithinReach(sentences, endId, reachLo, Math.max(prefs.max_ms, reach), prefs.min_ms, short_exception || window.min_relaxed);
    try {
      const pick = await input.picker({ sentences, end_id: endId, snap_start_id: snap.start_id, candidate_start_ids: offered, anchor_ms: T, prefs, short_exception });
      if (!pick) model_rejection = "picker returned nothing";
      else if (!offered.includes(pick.start_id)) model_rejection = `start ${pick.start_id} is not among the offered candidates`;
      else {
        chosen = { start_id: pick.start_id, end_id: endId, reason: pick.reason };
        method = "model";
      }
    } catch (err) {
      model_rejection = `picker failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const start = sentences[chosen.start_id]!;
  const end = sentences[chosen.end_id]!;
  // A start the model reached for lies before the rules' window: its lead-in may go back as far as the reach does.
  const padded = pad(input.transcript, start.start_word, end.end_word, start.start_ms < lo ? reachLo : lo, hi, prefs);
  return {
    ...padded,
    start_word: start.start_word,
    end_word: end.end_word,
    method,
    window,
    version: SELECTOR_VERSION,
    model_rejection,
    sentences,
    eligible_end_ids,
    candidates: candidates.slice(0, 10),
    snap,
    chosen,
  };
}

/**
 * The latest `n` sentence ends. A short sentence by a different speaker than the preceding full sentence
 * ("Right.", "Yeah.") is an interjection and is skipped; a short sentence by the same speaker is the end
 * of their thought and is kept.
 */
function chooseEnds(eligible: (Sentence & { eligible: boolean })[], n: number): number[] {
  const ends: number[] = [];
  for (let i = eligible.length - 1; i >= 0 && ends.length < n; i--) {
    const s = eligible[i]!;
    if (s.word_count < 4) {
      const prevFull = [...eligible.slice(0, i)].reverse().find((p) => p.word_count >= 4);
      if (prevFull && prevFull.speaker !== s.speaker) continue;
    }
    ends.push(s.id);
  }
  return ends;
}

/**
 * Valid starts for the fixed end, ordered by preference: distance from the target duration, with the scored
 * signals deciding only among candidates inside the snap band.
 */
function startCandidates(sentences: (Sentence & { eligible: boolean })[], endId: number, prefs: SelectPrefs, shortException: boolean): ScoredCandidate[] {
  const end = sentences[endId]!;
  const out: ScoredCandidate[] = [];
  for (let startId = endId; startId >= 0; startId--) {
    const start = sentences[startId]!;
    if (!start.eligible) break;
    const duration_ms = end.end_ms - start.start_ms;
    if (!shortException && duration_ms < prefs.min_ms) continue;
    if (duration_ms > prefs.max_ms) break;
    const reasons: string[] = [];
    let score = 0;
    const prev = sentences[startId - 1];
    if (prev === undefined || prev.speaker !== start.speaker) { score += 3; reasons.push("speaker turn"); }
    if (/\?$/.test(start.text)) {
      const answered = end.speaker !== start.speaker;
      score += answered ? 3 : 2;
      reasons.push(answered ? "question answered" : "question");
    } else if (FRAMING.test(start.text)) { score += 2; reasons.push("framing"); }
    if (prev !== undefined && start.start_ms - prev.end_ms >= 1500) { score += 2; reasons.push("pause before"); }
    if (duration_ms >= prefs.good_min_ms && duration_ms <= prefs.good_max_ms) { score += 1; reasons.push("good length"); }
    else if (duration_ms > prefs.good_max_ms) { const penalty = Math.ceil((duration_ms - prefs.good_max_ms) / 30_000); score -= penalty; reasons.push(`long -${penalty}`); }
    if (CONTINUATION.test(start.text)) { score -= 3; reasons.push("continuation"); }
    out.push({ start_id: startId, end_id: endId, duration_ms, distance_ms: Math.abs(duration_ms - prefs.target_ms), score, reasons });
  }
  if (out.length === 0) return out;
  const nearest = Math.min(...out.map((c) => c.distance_ms));
  const band = prefs.snap_band_ms;
  out.sort((a, b) => {
    const aIn = a.distance_ms <= nearest + band;
    const bIn = b.distance_ms <= nearest + band;
    if (aIn !== bIn) return aIn ? -1 : 1;
    if (aIn && bIn && b.score !== a.score) return b.score - a.score;
    return a.distance_ms - b.distance_ms || b.start_id - a.start_id;
  });
  return out;
}

/**
 * Every whole-sentence start a picker with reach may choose for the fixed end, earliest first: back to `reachLo`,
 * as long as the span is no longer than `maxMs` and, unless the window itself is short, no shorter than `minMs`.
 */
function startsWithinReach(sentences: (Sentence & { eligible: boolean })[], endId: number, reachLo: number, maxMs: number, minMs: number, anyLength: boolean): number[] {
  const end = sentences[endId]!;
  const out: number[] = [];
  for (let startId = endId; startId >= 0; startId--) {
    const start = sentences[startId]!;
    if (start.start_ms < reachLo) break;
    const duration_ms = end.end_ms - start.start_ms;
    if (!anyLength && duration_ms < minMs) continue;
    if (duration_ms > maxMs) break;
    out.push(startId);
  }
  return out.reverse();
}

/** Add lead and tail padding without crossing the window or touching a neighbouring word. */
function pad(t: NormalizedTranscript, startWord: number, endWord: number, lo: number, hi: number, prefs: SelectPrefs): { start_ms: number; end_ms: number } {
  const first = sliceWords(t, startWord, startWord + 1)[0]!;
  const last = sliceWords(t, endWord - 1, endWord)[0]!;
  const prev: WordTuple | undefined = startWord > 0 ? sliceWords(t, startWord - 1, startWord)[0] : undefined;
  const next: WordTuple | undefined = endWord < t.word_count ? sliceWords(t, endWord, endWord + 1)[0] : undefined;
  const start_ms = Math.max(lo, first[0] - prefs.lead_pad_ms, prev ? prev[1] : 0);
  const end_ms = Math.min(hi, last[1] + prefs.tail_pad_ms, next ? next[0] : Number.POSITIVE_INFINITY);
  return { start_ms, end_ms: Math.max(end_ms, start_ms) };
}

/** Deterministic fallback: the last `target_ms` before the tap, snapped to words when a transcript exists. */
function fixedSpan(t: NormalizedTranscript | null, lo: number, hi: number, prefs: SelectPrefs): Pick<Selection, "start_ms" | "end_ms" | "start_word" | "end_word" | "method"> {
  const start_ms = Math.max(lo, hi - prefs.target_ms);
  const end_ms = hi;
  if (!t) return { start_ms, end_ms, start_word: null, end_word: null, method: "fixed" };
  const range = wordRangeByMidpoint(t, start_ms, end_ms);
  return { start_ms, end_ms, start_word: range?.start_word ?? null, end_word: range?.end_word ?? null, method: "fixed" };
}

/** Words whose midpoint lies inside `[start_ms, end_ms]`, as a global index range, or null when none. */
export function wordRangeByMidpoint(t: NormalizedTranscript, start_ms: number, end_ms: number): { start_word: number; end_word: number } | null {
  let first: number | null = null;
  let last: number | null = null;
  for (const s of t.segments) {
    if (s.end_ms < start_ms || s.start_ms > end_ms) continue;
    s.words.forEach((w, i) => {
      const mid = (w[0] + w[1]) / 2;
      if (mid >= start_ms && mid <= end_ms) {
        const idx = s.first_word + i;
        if (first === null) first = idx;
        last = idx;
      }
    });
  }
  return first === null || last === null ? null : { start_word: first, end_word: last + 1 };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
