/**
 * Chapter start points a publisher supplies: a Podcasting 2.0 JSON chapters file (`<podcast:chapters>`), Podlove
 * Simple Chapters inline in the feed item (`<psc:chapters>`), or timestamps in the show notes (showNotes.ts).
 * A point is only a start time and a title; the service turns a list of them into chapters that end where the next
 * begins and maps each start to a transcript word (`firstWordAtOrAfter`). Pure: no I/O.
 *
 * Every publisher time refers to the publisher's edit of the recording. Dynamic ad insertion shifts the file we
 * download relative to it, by the length of the ads inserted before each point (NPR's Up First, for one). Nothing
 * here corrects that: a chapter can start early by an ad break's length. The episode's detected `ad_breaks` could
 * shift each point later; that is not done yet.
 */
import type { WordTuple } from "../transcript/types.js";

export type ChapterPoint = { start_ms: number; title: string };
export type ChapterKind = "content" | "intro" | "ad" | "outro";

/** A first chapter this close to the start is taken to begin the episode (its start becomes 0). */
export const FIRST_CHAPTER_MAX_MS = 180_000;
export const TITLE_MAX = 200;
/** No publisher list is this long; a longer one is a transcript or a playlist, not chapters. */
const MAX_POINTS = 500;

/**
 * Show-notes clock times: `M:SS`, `MM:SS`, `MMM:SS` (minutes past 59, as some notes write them), or `H:MM:SS`.
 * Seconds (and minutes, with hours) must be below 60. Returns milliseconds, or null when it is not a clock time.
 */
export function parseClock(s: string): number | null {
  const m = /^(?:(\d{1,2}):([0-5]\d):([0-5]\d)|(\d{1,3}):([0-5]\d))$/.exec(s.trim());
  if (!m) return null;
  const seconds = m[1] !== undefined ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(m[4]) * 60 + Number(m[5]);
  return seconds * 1000;
}

/** Podlove's normal play time: `[[HH:]MM:]SS[.mmm]`, e.g. `00:01:02.500` or `62.5`. */
export function parseNpt(s: string): number | null {
  const m = /^(?:(?:(\d+):)?(\d+):)?(\d+(?:\.\d+)?)$/.exec(s.trim());
  if (!m) return null;
  const seconds = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3]);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
}

/**
 * The points of a Podcasting 2.0 JSON chapters document (`{"version": "1.2.0", "chapters": [{"startTime": 0,
 * "title": "…"}]}`). Chapters marked `"toc": false` are images or links for a moment, not table-of-contents
 * entries, and are skipped, as are untitled ones. Null when the document has no usable chapters.
 */
export function jsonChapters(doc: unknown): ChapterPoint[] | null {
  if (!doc || typeof doc !== "object") return null;
  const list = (doc as { chapters?: unknown }).chapters;
  if (!Array.isArray(list)) return null;
  const points: ChapterPoint[] = [];
  for (const c of list.slice(0, MAX_POINTS)) {
    if (!c || typeof c !== "object") continue;
    const { startTime, title, toc } = c as { startTime?: unknown; title?: unknown; toc?: unknown };
    if (toc === false || typeof title !== "string") continue;
    const seconds = typeof startTime === "number" ? startTime : typeof startTime === "string" ? Number(startTime) : NaN;
    if (!Number.isFinite(seconds) || seconds < 0) continue;
    points.push({ start_ms: Math.round(seconds * 1000), title });
  }
  return orderedPoints(points);
}

/**
 * Tidy a publisher's list: trimmed non-empty titles, sorted by start, one point per start time, capped in length.
 * Null when fewer than two remain, since one chapter seeks nowhere.
 */
export function orderedPoints(points: readonly ChapterPoint[]): ChapterPoint[] | null {
  const tidy = points
    .map((p) => ({ start_ms: Math.max(0, Math.round(p.start_ms)), title: cleanTitle(p.title) }))
    .filter((p) => Number.isFinite(p.start_ms) && p.title.length > 0)
    .sort((a, b) => a.start_ms - b.start_ms);
  const out: ChapterPoint[] = [];
  for (const p of tidy) if (out.length === 0 || out[out.length - 1]!.start_ms !== p.start_ms) out.push(p);
  return out.length >= 2 ? out.slice(0, MAX_POINTS) : null;
}

/**
 * Feed chapters (JSON or psc) as they apply to one recording: points at or past its end are dropped, since the
 * file we have is shorter than the edition they were written for. Null when fewer than two remain.
 */
export function feedChapterPoints(points: readonly ChapterPoint[], duration_ms: number): ChapterPoint[] | null {
  const ordered = orderedPoints(points);
  if (!ordered) return null;
  const inside = ordered.filter((p) => p.start_ms < duration_ms);
  return inside.length >= 2 ? inside : null;
}

export function cleanTitle(title: string): string {
  const t = title.replace(/\s+/g, " ").trim();
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1).trimEnd()}…` : t;
}

/** The summary's chapter kinds, guessed from a publisher title so sponsor reads are labelled as the model labels them. */
export function chapterKind(title: string): ChapterKind {
  if (/\bsponsor/i.test(title) || /^(ads?|ad break|advertisement)\b/i.test(title)) return "ad";
  if (/^(intros?|introductions?|cold open|opening)\b/i.test(title)) return "intro";
  if (/^(outro|closing|wrap[- ]?up|end of episode)\b/i.test(title)) return "outro";
  return "content";
}

/**
 * Index of the first word starting at or after `ms` (binary search over words sorted by start), or `words.length`
 * when every word starts earlier. A chapter starting mid-word therefore begins on the next whole word.
 */
export function firstWordAtOrAfter(words: readonly WordTuple[], ms: number): number {
  let lo = 0;
  let hi = words.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (words[mid]![0] < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
