/**
 * Chapters the publisher wrote, ahead of the model's: the feed's own (`<podcast:chapters>` JSON or Podlove Simple
 * Chapters, stored on the episode at refresh) and then the timestamps in the show notes (read from
 * `description_html` each time the episode is served, so improving the parser needs no backfill). The order of all
 * sources is in `chaptersFor` (episodes.ts): aligned publisher text, then these, then the summary's.
 *
 * The only network call is fetching a JSON chapters file, done from the fetch_audio job and the feed refresh with
 * `safeFetch` (free; nothing here bills), never from a request handler.
 */
import type { AppContext } from "../app/context.js";
import { chapterKind, feedChapterPoints, FIRST_CHAPTER_MAX_MS, firstWordAtOrAfter, jsonChapters, type ChapterPoint } from "../core/chapters/points.js";
import { showNotesChapters } from "../core/chapters/showNotes.js";
import type { WordTuple } from "../core/transcript/types.js";
import type { AudioAssetRow, EpisodeRow } from "../db/rows.js";
import { redact, safeFetch } from "../lib/safeFetch.js";
import type { ChapterItem, EpisodeChapters } from "./episodes.js";

const CHAPTERS_MAX_BYTES = 1024 * 1024;
/** JSON chapter files fetched per feed refresh for episodes that already have audio (a backfill, kept small). */
const REFRESH_FETCH_LIMIT = 5;

/**
 * The feed's chapters, else the show notes', laid over the episode's recording (or, before the audio is fetched,
 * the feed's duration hint); null when the publisher gave neither. With a current transcript each chapter starts on
 * the first word at or after its time, so the transcript, snips, and chapter list agree on where a chapter begins.
 */
export function publishedChapters(ctx: AppContext, ep: EpisodeRow, asset: AudioAssetRow | null): EpisodeChapters {
  const duration_ms = asset?.duration_ms ?? ep.duration_hint_ms;
  if (!duration_ms) return null;
  const stored = ep.feed_chapters ? (JSON.parse(ep.feed_chapters) as ChapterPoint[]) : [];
  const feed = feedChapterPoints(stored, duration_ms);
  if (feed) return laidOver(ctx, "feed", feed, duration_ms, asset);
  const notes = showNotesChapters(ep.description_html, duration_ms);
  if (notes) return laidOver(ctx, "shownotes", notes, duration_ms, asset);
  return null;
}

/** Points become chapters that end where the next begins; a first chapter near the start begins the episode. */
function laidOver(ctx: AppContext, source: "feed" | "shownotes", points: ChapterPoint[], duration_ms: number, asset: AudioAssetRow | null): EpisodeChapters {
  const starts = points.map((p, i) => (i === 0 && p.start_ms <= FIRST_CHAPTER_MAX_MS ? 0 : p.start_ms));
  const transcriptId = asset?.transcript_id ?? null;
  const words = transcriptId ? wordsAt(ctx, transcriptId, starts) : null;
  const items: ChapterItem[] = points.map((p, i) => ({
    start_ms: starts[i]!,
    end_ms: starts[i + 1] ?? duration_ms,
    start_word: words ? words.starts[i]! : null,
    end_word: words ? (words.starts[i + 1] ?? words.word_count) : null,
    title: p.title,
    description: null,
    kind: chapterKind(p.title),
  }));
  return { source, transcript_id: transcriptId, items };
}

/** For each time, the index of the transcript's first word starting at or after it; `word_count` past the last word. */
function wordsAt(ctx: AppContext, transcriptId: string, starts: number[]): { starts: number[]; word_count: number } {
  const word_count = (ctx.db.prepare("SELECT word_count FROM transcript WHERE id = ?").pluck().get(transcriptId) as number | undefined) ?? 0;
  // The first segment still running at `ms` holds the answer, or ends before it and the next segment's first word is.
  const segment = ctx.db.prepare("SELECT first_word, words FROM transcript_segment WHERE transcript_id = ? AND end_ms > ? ORDER BY idx LIMIT 1");
  return {
    word_count,
    starts: starts.map((ms) => {
      const row = segment.get(transcriptId, ms) as { first_word: number; words: string } | undefined;
      if (!row) return word_count;
      return row.first_word + firstWordAtOrAfter(JSON.parse(row.words) as WordTuple[], ms);
    }),
  };
}

/**
 * Fetch and store the episode's JSON chapters file, if it has one not yet fetched. A file that is missing (4xx),
 * malformed, or has no usable chapters is recorded as `[]` so it is not asked for again; a server error or network
 * failure leaves it for the next attempt. Never throws: chapters are a nicety and must not fail the job around them.
 */
export async function fetchFeedChapters(ctx: AppContext, episodeId: string): Promise<void> {
  const ep = ctx.db.prepare("SELECT id, chapters_url_enc, feed_chapters FROM episode WHERE id = ?").get(episodeId) as Pick<EpisodeRow, "id" | "chapters_url_enc" | "feed_chapters"> | undefined;
  if (!ep?.chapters_url_enc || ep.feed_chapters !== null) return;
  const url = ctx.secrets.decrypt(ep.chapters_url_enc);
  const store = (points: ChapterPoint[] | null) => ctx.db.prepare("UPDATE episode SET feed_chapters = ? WHERE id = ? AND feed_chapters IS NULL").run(JSON.stringify(points ?? []), ep.id);
  try {
    const res = await safeFetch(url, { headers: { accept: "application/json+chapters, application/json;q=0.9, */*;q=0.1" }, maxBytes: CHAPTERS_MAX_BYTES, timeoutMs: 20_000, allowPrivateNetwork: ctx.config.allowPrivateNetwork });
    if (res.status !== 200) {
      await res.body?.cancel();
      if (res.status >= 400 && res.status < 500 && res.status !== 429) store(null);
      ctx.log("feed chapters not fetched", { episode_id: ep.id, status: res.status, url: redact(url) });
      return;
    }
    let points: ChapterPoint[] | null = null;
    try {
      points = jsonChapters(JSON.parse(await readCapped(res.body, CHAPTERS_MAX_BYTES)));
    } catch {
      points = null;
    }
    store(points);
    ctx.log("feed chapters stored", { episode_id: ep.id, chapters: points?.length ?? 0 });
  } catch (err) {
    ctx.log("feed chapters fetch failed", { episode_id: ep.id, url: redact(url), error: err instanceof Error ? err.message : String(err) });
  }
}

/** After a refresh: fetch chapter files for a few episodes that already have audio (and so never pass fetch_audio again). */
export async function fetchPendingFeedChapters(ctx: AppContext, feedId: string): Promise<void> {
  const ids = ctx.db
    .prepare("SELECT id FROM episode WHERE feed_id = ? AND current_asset_id IS NOT NULL AND chapters_url_enc IS NOT NULL AND feed_chapters IS NULL ORDER BY published_at DESC LIMIT ?")
    .pluck()
    .all(feedId, REFRESH_FETCH_LIMIT) as string[];
  for (const id of ids) await fetchFeedChapters(ctx, id);
}

async function readCapped(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`chapters file exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
