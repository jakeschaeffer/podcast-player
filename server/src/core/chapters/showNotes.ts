/**
 * Chapters from the timestamps publishers write into show notes: lines such as `00:00 Intro`, `(12:34) Topic`,
 * `1:02:03 - Topic`, `[05:10] Topic` or `* 4:19 Topic`, in `<li>`s, `<p>`s, or `<br>`-separated lines. Pure.
 *
 * Show notes are prose first, so a list is only believed when it looks like a table of contents: one unbroken run
 * of timestamp-led lines (a bulleted sentence under an entry doesn't break it), at least three, strictly increasing,
 * the first within three minutes of the start, none far past the end of the recording, typically 20 s or more
 * apart, each followed by a short title. That rules out a single time in prose ("jump to 15:55"), clock times
 * ("doors at 2:30pm"), sponsor codes, lists with a typo in their order (rejected, not repaired), and the transcripts
 * some shows paste into their notes, whose lines also open with a timestamp but run long or come seconds apart.
 * When several runs qualify the longest wins.
 *
 * Calibrated on the owner's shows (October 2026): Lex Fridman (`(00:00) – Introduction`, `<br>` lines), Latent
 * Space (`* [00:01:28] Topic` paragraphs, and newer notes with `* 4:19 Topic` plus a timestamped transcript),
 * NPR's Up First (`(02:29) Topic` after the credits). Stratechery and Cortex notes have none. The times refer to the
 * publisher's edit; see points.ts on dynamic ad insertion.
 */
import { DomHandler, Parser } from "htmlparser2";
import type { ChildNode, Element } from "domhandler";
import { FIRST_CHAPTER_MAX_MS, parseClock, type ChapterPoint } from "./points.js";

export const SHOWNOTES_MIN_POINTS = 3;
/** Longer than this is a sentence or a transcript paragraph, not a chapter title. */
const SHOWNOTES_TITLE_MAX = 120;

const BLOCK_TAGS = new Set(["p", "li", "div", "br", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "tr", "ul", "ol"]);
const SKIP_TAGS = new Set(["script", "style", "img"]);
const BULLET = /^(?:[*•·▪‣◦>-]|[–—])\s*/u;
const BULLET_LINE = /^(?:[*•·▪‣◦-]|[–—])\s+\S/u;
const TIME = String.raw`(\d{1,2}:\d{2}:\d{2}|\d{1,3}:\d{2})`;
const LEAD = new RegExp(String.raw`^[(\[]?\s*${TIME}`);
/** The end of a range written as `00:00 - 05:10 Topic`; dropped. */
const RANGE_END = new RegExp(String.raw`^\s*(?:[-–—]|to)\s*[(\[]?${TIME}[)\]]?(?=[\s\-–—:|]|$)`);
const SEPARATORS = /^[\s\-–—:|.,·•]+/u;
const GLUED = new RegExp(String.raw`(?<=[^\s\d(\[:])(?=(?:\d{1,2}:\d{2}:\d{2}|\d{1,3}:\d{2})\s)`, "u");
/** Chapters closer together than this, typically, are a timestamped transcript rather than a table of contents. */
const MIN_MEDIAN_GAP_MS = 20_000;

/**
 * The chapter points in a show-notes HTML fragment, or null when there is no credible list. `duration_ms` is the
 * recording's length (the asset's, else the feed's hint); points well past it reject the list, and points just
 * past it (the publisher's edition ran a little longer) are dropped.
 */
export function showNotesChapters(html: string | null, duration_ms: number | null): ChapterPoint[] | null {
  if (!html) return null;
  let best: ChapterPoint[] | null = null;
  let run: ChapterPoint[] = [];
  const close = () => {
    const ok = credibleRun(run, duration_ms);
    if (ok && (!best || ok.length > best.length)) best = ok;
    run = [];
  };
  for (const line of showNotesLines(html).flatMap(unglue)) {
    const point = timestampLine(line);
    if (point) run.push(point);
    // Some lists put a bulleted sentence under each timestamp; it neither ends the list nor becomes a chapter.
    else if (run.length > 0 && BULLET_LINE.test(line)) continue;
    else close();
  }
  close();
  return best;
}

/** The text of the notes, one entry per block or `<br>`-separated line, entities decoded, whitespace collapsed. */
export function showNotesLines(html: string): string[] {
  const handler = new DomHandler();
  const parser = new Parser(handler, { decodeEntities: true });
  parser.write(html);
  parser.end();
  const parts: string[] = [];
  const walk = (nodes: ChildNode[]) => {
    for (const node of nodes) {
      if (node.type === "text") parts.push(node.data);
      else if (node.type === "tag") {
        const el = node as Element;
        const tag = el.name.toLowerCase();
        if (SKIP_TAGS.has(tag)) continue;
        const block = BLOCK_TAGS.has(tag);
        if (block) parts.push("\n");
        walk(el.children);
        if (block) parts.push("\n");
      }
    }
  };
  walk(handler.dom);
  return parts.join("").split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => l.length > 0);
}

/**
 * A list whose line breaks were lost in the publisher's HTML reads `00:00 Welcome and Guests00:22 Announcing X01:41
 * Architecture`: a timestamp-led line with more timestamps glued to the end of each title. Split it before each
 * timestamp that follows a non-space character directly. A timestamp after a space, as in transcripts written
 * `(00:05) Welcome. (00:06) We're here`, is left in the text, so such a paragraph stays one (too long) title.
 */
function unglue(line: string): string[] {
  if (!timestampLine(line)) return [line];
  return line.split(GLUED).map((l) => l.trim()).filter((l) => l.length > 0);
}

/** `{ start_ms, title }` when the line opens with a timestamp (after an optional bullet) and goes on to a title. */
export function timestampLine(line: string): ChapterPoint | null {
  const body = line.replace(BULLET, "");
  const lead = LEAD.exec(body);
  if (!lead) return null;
  const start_ms = parseClock(lead[1]!);
  if (start_ms === null) return null;
  let rest = body.slice(lead[0].length);
  // "2:30pm", "12:345", "1:02:03:04": the time runs on into something else.
  if (/^[\p{L}\d:]/u.test(rest)) return null;
  rest = rest.replace(/^\s*[)\]]/, "").replace(RANGE_END, "").replace(SEPARATORS, "");
  if (/^[ap]\.?m\b\.?/i.test(rest)) return null; // "2:30 pm ET"
  const title = rest.replace(/[\s\-–—:|]+$/u, "").trim();
  return title.length > 0 ? { start_ms, title } : null;
}

/** The run as chapters if it reads like a table of contents for this recording, else null. */
function credibleRun(run: readonly ChapterPoint[], duration_ms: number | null): ChapterPoint[] | null {
  if (run.length < SHOWNOTES_MIN_POINTS) return null;
  if (run[0]!.start_ms > FIRST_CHAPTER_MAX_MS) return null;
  for (let i = 1; i < run.length; i++) if (run[i]!.start_ms <= run[i - 1]!.start_ms) return null;
  if (!run.every((p) => plausibleTitle(p.title))) return null;
  const gaps = run.slice(1).map((p, i) => p.start_ms - run[i]!.start_ms).sort((a, b) => a - b);
  if (gaps[Math.floor(gaps.length / 2)]! < MIN_MEDIAN_GAP_MS) return null;
  if (duration_ms === null) return [...run];
  // Slack for an edition a little longer than our file (an intro or ad cut, a video cut of the same talk).
  const slack = Math.max(60_000, duration_ms * 0.05);
  if (run[run.length - 1]!.start_ms > duration_ms + slack) return null;
  const inside = run.filter((p) => p.start_ms < duration_ms);
  return inside.length >= SHOWNOTES_MIN_POINTS ? inside : null;
}

function plausibleTitle(title: string): boolean {
  if (title.length < 2 || title.length > SHOWNOTES_TITLE_MAX) return false;
  if (!/\p{L}/u.test(title)) return false;
  if (/^(https?:\/\/|www\.)\S*$/i.test(title)) return false;
  return true;
}
