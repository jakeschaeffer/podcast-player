/**
 * Find the ad breaks in a recording, so the player can offer "Skip ad" while one plays. Pure and deterministic; no
 * model call. Three signals, strongest first:
 *
 * 1. Publisher gap. When the publisher's own text was aligned to the audio, an ad is speech that the text does not
 *    have: a long run of ASR words with no counterpart in the article. This gives exact boundaries.
 * 2. Sponsor phrases in the speech ("this update is presented by", "promo code"), bounded by the end of the read:
 *    a "back to the update" or "onto the update" line, a music sting, a long pause, or the recording's end. Stratechery prints its sponsor read in the article
 *    too, so this signal stands on its own even where publisher text exists (no gap appears there).
 * 3. Chapters the episode summary labelled `ad`.
 *
 * Signals that overlap merge into one break. A gap gives both edges when present. Otherwise the break opens at the
 * earliest signal and ends where the most exact one does: a read that ended on a hand-back line, sting or the
 * recording's end, then the chapter, then a read that ended on a pause.
 *
 * Words are not stored: a break is milliseconds on the asset, and skipping it seeks to `end_ms`, which sits just
 * before the first word after the break.
 */
import { alignTokens } from "../transcript/align.js";
import { normalizeToken } from "../transcript/tokens.js";
import type { NormalizedTranscript } from "../transcript/types.js";

/** Bump when the rules change; stored detections from an older version are recomputed. */
export const AD_DETECTOR_VERSION = "ads_v3";

export type AdSource = "publisher_gap" | "sponsor_phrase" | "ad_chapter";

export type AdBreak = {
  start_ms: number;
  /** Where "Skip ad" lands: just before the first word after the break. */
  end_ms: number;
  /** `high` when two signals agree; `medium` when one does. */
  confidence: "high" | "medium";
  sources: AdSource[];
  /** The sponsor phrase heard in the break, as normalized words, if any. */
  cue: string | null;
};

export type AdInput = {
  /** The ASR transcript: the only one that holds an ad's words. */
  speech: NormalizedTranscript | null;
  /**
   * The publisher's text aligned to the same recording. `verbatim` when the text is read word for word (Updates and
   * Articles): then a long passage missing from it is an ad even without a sponsor phrase. Interviews are edited
   * transcripts that drop whole passages, so there a gap needs a second signal.
   */
  publisher?: { transcript: NormalizedTranscript; verbatim: boolean } | null;
  /** The summary's chapters; those of kind `ad` are candidates. */
  chapters?: readonly { start_ms: number; end_ms: number; kind: string }[] | null;
  duration_ms: number;
};

export type AdOptions = {
  /** A publisher gap shorter than this is an aside or an intro line, not an ad. */
  min_gap_ms: number;
  /** A gap with no second signal counts only in verbatim text, and only from this long. */
  lone_gap_min_ms: number;
  /** Matched words inside a gap that still count as part of it (an ad's "the" aligned to the article's). */
  max_island_words: number;
  /** Share of a gap's words that must be unmatched. */
  min_unmatched_share: number;
  /** No break is shorter than this or longer than `max_break_ms`. */
  min_break_ms: number;
  max_break_ms: number;
  /** A sponsor read with no end found within this long is left alone rather than guessed. */
  max_read_ms: number;
  /** A read that runs to the end of the recording counts as a post-roll only up to this long. */
  max_postroll_ms: number;
  /** Silence that ends a sponsor read, once it has run `min_read_ms`. */
  read_end_pause_ms: number;
  min_read_ms: number;
};

export const DEFAULT_AD_OPTIONS: AdOptions = {
  min_gap_ms: 20_000,
  lone_gap_min_ms: 45_000,
  max_island_words: 3,
  min_unmatched_share: 0.75,
  min_break_ms: 10_000,
  max_break_ms: 6 * 60_000,
  max_read_ms: 120_000,
  max_postroll_ms: 90_000,
  read_end_pause_ms: 1_500,
  min_read_ms: 15_000,
};

/** Phrases that open or carry a sponsor read. Matched against normalized words joined by single spaces. */
const STRONG_CUES: RegExp[] = [
  /\b(?:this|today's|the) (?:daily |weekly )?(?:episode|show|podcast|update|interview|article|post|essay|newsletter|program|segment|conversation)(?: of [a-z']+(?: [a-z']+)?)? (?:is |was )?(?:brought to you|sponsored|supported|presented|powered|underwritten|made possible) by\b/g,
  /\bbrought to you by\b/g,
  /\b(?:thanks|thank you) to (?:our|today's|this week's|this episode's) sponsors?\b/g,
  /\b(?:a |one )?(?:quick |short |brief )?(?:word|message|break) from (?:our|today's|this week's) sponsors?\b/g,
  /\bsupport for (?:this|the) (?:show|podcast|episode) comes from\b/g,
  /\bour sponsor (?:today|this week|for this episode)\b/g,
  /\btoday's sponsor\b/g,
  /\b(?:presenting|title|exclusive) sponsor\b/g,
  /\b(?:promo|discount|coupon) code\b/g,
];

/** Phrases common in ad copy but also in ordinary talk: they confirm a break, never start one. */
const WEAK_CUES: RegExp[] = [
  /\bsponsored by\b/g,
  /\bsponsors?\b/g,
  /\buse (?:the )?code\b/g,
  /\bfree trial\b/g,
  /\b(?:first|1st) (?:month|week) free\b/g,
  /\b\d+ percent off\b/g,
  /\b(?:sign up|get started|head over|go) (?:today |now )?(?:at|to) [a-z0-9]+ ?(?:dot ?)?(?:com|ai|io|co)\b/g,
  /\bterms (?:and conditions )?apply\b/g,
  /\blimited time\b/g,
];

/** Lines that hand back to the show at the end of a read. */
const END_CUES: RegExp[] = [/\b(?:on|onto|on to) (?:the|today's) (?:update|show|episode|interview|article)\b/g, /\b(?:and )?(?:now )?back to (?:the|our) (?:show|episode|interview|conversation|update|program)\b/g, /\band now (?:on|back) (?:to|with) the show\b/g];

type Word = { text: string; tok: string; start_ms: number; end_ms: number };
type Cue = { word: number; strong: boolean; phrase: string };
/** `firm`: a read that ended on a hand-back line or a sting. `qualifies`: a gap that counts with no second signal. */
type Candidate = { start_ms: number; end_ms: number; source: AdSource; cue?: string; firm?: boolean; qualifies?: boolean };

export function detectAds(input: AdInput, options: Partial<AdOptions> = {}): AdBreak[] {
  const opts: AdOptions = { ...DEFAULT_AD_OPTIONS, ...options };
  const words = input.speech ? flatWords(input.speech) : [];
  const cues = findCues(words, STRONG_CUES, true).concat(findCues(words, WEAK_CUES, false));
  const endCues = new Set(findCues(words, END_CUES, true).map((c) => c.word));
  const adChapters = (input.chapters ?? [])
    .filter((c) => c.kind === "ad" && c.end_ms - c.start_ms >= opts.min_break_ms && c.end_ms - c.start_ms <= opts.max_break_ms)
    .map((c): Candidate => ({ start_ms: c.start_ms, end_ms: c.end_ms, source: "ad_chapter" }));

  const gaps = input.publisher && words.length > 0
    ? publisherGaps(words, input.publisher.transcript, opts).map((g): Candidate => ({ ...g, source: "publisher_gap", qualifies: input.publisher!.verbatim && g.end_ms - g.start_ms >= opts.lone_gap_min_ms }))
    : [];
  const reads = cues.filter((c) => c.strong).map((c) => sponsorRead(words, c, endCues, input.speech?.events ?? [], opts)).filter((x): x is Candidate => x !== null);

  const breaks: AdBreak[] = [];
  for (const group of mergeOverlapping([...gaps, ...adChapters, ...reads])) {
    const gap = group.find((c) => c.source === "publisher_gap");
    const chapter = group.find((c) => c.source === "ad_chapter");
    const read = group.find((c) => c.source === "sponsor_phrase" && c.firm) ?? group.find((c) => c.source === "sponsor_phrase");
    // A gap alone is an aside or a cut passage unless the text is verbatim and the gap is long.
    if (gap && !chapter && !read && !gap.qualifies && !cueIn(cues, words, gap.start_ms, gap.end_ms)) continue;
    // Without a gap, the break opens at the earliest signal: a read opens on its cue's sentence, which can come after
    // the ad's first lines ("…the presenting sponsor"), or before a chapter's start where the model cut mid-sentence.
    const span = { start_ms: gap ? gap.start_ms : Math.min(...group.map((c) => c.start_ms)), end_ms: (gap ?? (read?.firm ? read : undefined) ?? chapter ?? read)!.end_ms };
    const cue = cueIn(cues, words, span.start_ms - 5_000, span.end_ms);
    const sources: AdSource[] = [];
    if (gap) sources.push("publisher_gap");
    if (read || cue) sources.push("sponsor_phrase");
    if (chapter) sources.push("ad_chapter");
    breaks.push({ start_ms: span.start_ms, end_ms: span.end_ms, confidence: sources.length > 1 ? "high" : "medium", sources, cue: read?.cue ?? cue?.phrase ?? null });
  }

  return breaks
    .map((b) => ({ ...b, start_ms: Math.max(0, Math.round(b.start_ms)), end_ms: Math.min(input.duration_ms, Math.round(b.end_ms)) }))
    .filter((b) => b.end_ms - b.start_ms >= opts.min_break_ms && b.end_ms - b.start_ms <= opts.max_break_ms)
    .sort((a, b) => a.start_ms - b.start_ms);
}

function flatWords(t: NormalizedTranscript): Word[] {
  const out: Word[] = [];
  for (const s of t.segments) for (const w of s.words) out.push({ text: w[2], tok: normalizeToken(w[2]), start_ms: w[0], end_ms: w[1] });
  return out;
}

/** Every match of the patterns over the spoken words, located at the word it starts on (an index into `words`). */
function findCues(words: Word[], patterns: RegExp[], strong: boolean): Cue[] {
  const at: number[] = [];
  let text = "";
  words.forEach((w, k) => {
    if (!w.tok) return;
    if (text) text += " ";
    at.push(k);
    text += w.tok;
  });
  // Character offset of each token in `text`, for mapping a match back to its word.
  const offsets: number[] = [];
  let pos = 0;
  for (const k of at) { offsets.push(pos); pos += words[k]!.tok.length + 1; }
  const out: Cue[] = [];
  for (const re of patterns) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      let lo = 0, hi = offsets.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (offsets[mid]! <= m.index) lo = mid; else hi = mid - 1; }
      out.push({ word: at[lo]!, strong, phrase: m[0] });
    }
  }
  return out.sort((a, b) => a.word - b.word);
}

function cueIn(cues: Cue[], words: Word[], from_ms: number, to_ms: number): Cue | undefined {
  const inside = cues.filter((c) => words[c.word]!.start_ms >= from_ms && words[c.word]!.start_ms < to_ms);
  return inside.find((c) => c.strong) ?? inside[0];
}

/** Runs of speech the publisher's text does not have, at least `min_gap_ms` long. */
function publisherGaps(words: Word[], publisher: NormalizedTranscript, opts: AdOptions): { start_ms: number; end_ms: number }[] {
  const spoken = words.map((w, k) => ({ w, k })).filter((x) => x.w.tok);
  const ref = flatWords(publisher).map((w) => w.tok).filter(Boolean);
  if (spoken.length === 0 || ref.length === 0) return [];
  const { pairs } = alignTokens(ref, spoken.map((x) => x.w.tok));
  const matched = new Uint8Array(spoken.length);
  for (const [, j] of pairs) matched[j] = 1;

  // Unmatched runs, joined across islands of a few matched words.
  const runs: [number, number][] = [];
  for (let j = 0; j < spoken.length; j++) {
    if (matched[j]) continue;
    let end = j;
    while (end + 1 < spoken.length && !matched[end + 1]) end++;
    const last = runs[runs.length - 1];
    if (last && j - last[1] - 1 <= opts.max_island_words) last[1] = end;
    else runs.push([j, end]);
    j = end;
  }

  const out: { start_ms: number; end_ms: number }[] = [];
  for (const [a, b] of runs) {
    const first = spoken[a]!.w;
    const last = spoken[b]!.w;
    if (last.end_ms - first.start_ms < opts.min_gap_ms) continue;
    let unmatched = 0;
    for (let j = a; j <= b; j++) if (!matched[j]) unmatched++;
    if (unmatched / (b - a + 1) < opts.min_unmatched_share) continue;
    out.push({ start_ms: first.start_ms, end_ms: resumeAt(last, spoken[b + 1]?.w) });
  }
  return out;
}

/** Where playback should resume after a break that ends with `last`: just before the next word, if it comes soon. */
function resumeAt(last: Word, next: Word | undefined): number {
  if (next && next.start_ms - last.end_ms <= 3_000) return Math.max(last.end_ms, next.start_ms - 100);
  return last.end_ms + 300;
}

/**
 * The extent of a sponsor read that a strong cue opens: from the start of the cue's sentence to the first hand-back
 * line, music sting, long pause, or the end of the recording after it. Null when no end is found within `max_read_ms`; a skip that might land
 * in the middle of the episode is worse than none.
 */
function sponsorRead(words: Word[], cue: Cue, endCues: Set<number>, events: NormalizedTranscript["events"], opts: AdOptions): Candidate | null {
  let s = cue.word;
  // Back to the sentence start: the previous word ends a sentence, or a pause comes before this one.
  while (s > 0 && !/[.!?…]["')\]]*$/.test(words[s - 1]!.text) && words[s]!.start_ms - words[s - 1]!.end_ms < 700) s--;
  const start = words[s]!.start_ms;
  const limit = start + opts.max_read_ms;
  const music = events.filter(([a, , label]) => /music|jingle|sting/i.test(label) && a >= start + opts.min_break_ms && a <= limit);

  for (let k = cue.word; k < words.length && words[k]!.start_ms <= limit; k++) {
    const w = words[k]!;
    if (endCues.has(k)) {
      // Through the end of the hand-back sentence.
      let e = k;
      while (e + 1 < words.length && !/[.!?…]["')\]]*$/.test(words[e]!.text) && words[e + 1]!.start_ms - words[e]!.end_ms < 700) e++;
      return { start_ms: start, end_ms: resumeAt(words[e]!, words[e + 1]), source: "sponsor_phrase", cue: cue.phrase, firm: true };
    }
    const sting = music.find(([a]) => a >= w.end_ms && a < (words[k + 1]?.start_ms ?? Infinity));
    if (sting) return { start_ms: start, end_ms: Math.max(sting[1], w.end_ms), source: "sponsor_phrase", cue: cue.phrase, firm: true };
    const next = words[k + 1];
    // A post-roll read runs to the end of the recording; skipping it finishes the episode.
    if (!next && w.end_ms - start >= opts.min_read_ms && w.end_ms - start <= opts.max_postroll_ms) return { start_ms: start, end_ms: Number.MAX_SAFE_INTEGER, source: "sponsor_phrase", cue: cue.phrase, firm: true };
    if (next && w.end_ms - start >= opts.min_read_ms && next.start_ms - w.end_ms >= opts.read_end_pause_ms) {
      return { start_ms: start, end_ms: resumeAt(w, next), source: "sponsor_phrase", cue: cue.phrase };
    }
  }
  return null;
}

function mergeOverlapping(cands: Candidate[]): Candidate[][] {
  const sorted = [...cands].sort((a, b) => a.start_ms - b.start_ms);
  const groups: Candidate[][] = [];
  let end = -Infinity;
  for (const c of sorted) {
    const group = groups[groups.length - 1];
    if (group && c.start_ms <= end + 2_000) { group.push(c); end = Math.max(end, c.end_ms); }
    else { groups.push([c]); end = c.end_ms; }
  }
  return groups;
}
