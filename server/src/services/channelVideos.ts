/**
 * What the home fetcher knows about videos without downloading them (docs/video-plan.md, "Details first"). The server
 * cannot reach YouTube beyond a channel's public feed, which has the latest fifteen videos and no lengths, so the
 * fetcher sends a video's details, and on the owner's request walks further down the channel, fifteen new videos at
 * a time. Nothing here queues a download or bills: a listed video is fetched only when the owner asks.
 */
import type { AppContext } from "../app/context.js";
import { badRequest } from "../app/errors.js";
import type { ChapterPoint } from "../core/chapters/points.js";
import type { FeedRow } from "../db/rows.js";
import { newId } from "../lib/ids.js";
import { sanitizeShowNotes } from "../lib/sanitize.js";
import { descriptionHtml, getFeedRow } from "./feeds.js";
import { getEpisodeRow } from "./episodes.js";

export const MORE_VIDEOS_PAGE = 15;
/** How long to wait before each try at captions that failed: an hour, then longer. After the last, nothing more. */
const CAPTION_RETRY_HOURS = [1, 3, 6, 12, 24];

export type MoreVideosStatus = "idle" | "requested" | "failed" | "ended";
export type MoreVideosView = { status: MoreVideosStatus; error: string | null };

export function moreVideosView(row: Pick<FeedRow, "listing_wanted" | "listing_ended" | "listing_error">): MoreVideosView {
  if (row.listing_ended === 1) return { status: "ended", error: null };
  if (row.listing_wanted > 0) return { status: "requested", error: null };
  if (row.listing_error) return { status: "failed", error: row.listing_error };
  return { status: "idle", error: null };
}

/** The owner asked for the next fifteen. Asking twice before they arrive is still fifteen. */
export function requestMoreVideos(ctx: AppContext, feedId: string): void {
  const feed = getFeedRow(ctx, feedId);
  if (feed.kind !== "youtube") throw badRequest("only a YouTube channel has more videos to list");
  if (feed.listing_ended === 1) return;
  ctx.db.prepare("UPDATE feed SET listing_wanted = ?, listing_error = NULL WHERE id = ?").run(MORE_VIDEOS_PAGE, feedId);
}

export type WantedListing = { feed_id: string; channel_id: string; offset: number; count: number };

/** Channels whose owner asked for more videos, for the fetcher. */
export function wantedListings(ctx: AppContext): WantedListing[] {
  const rows = ctx.db.prepare("SELECT * FROM feed WHERE kind = 'youtube' AND listing_wanted > 0 AND listing_ended = 0 ORDER BY id").all() as FeedRow[];
  const out: WantedListing[] = [];
  for (const row of rows) {
    const channel = new URL(ctx.secrets.decrypt(row.url_enc)).searchParams.get("channel_id");
    if (channel) out.push({ feed_id: row.id, channel_id: channel, offset: row.listing_offset, count: row.listing_wanted });
  }
  return out;
}

export type ListedVideo = { youtube_id: string; title: string; duration_ms?: number | null | undefined; thumbnail_url?: string | null | undefined; published_at?: number | null | undefined };

/**
 * A page of the channel's videos, newest first. Those the library lacks become episodes (the feed already gave the
 * latest, so a page can hold few new ones, and the fetcher goes on until enough are new). A listing rarely says when a
 * video came out: until its details arrive it is placed just below the channel's oldest, in the channel's own order.
 */
export function storeListing(ctx: AppContext, feedId: string, videos: ListedVideo[], ended: boolean): { added: number; wanted: number } {
  const feed = getFeedRow(ctx, feedId);
  if (feed.kind !== "youtube") throw badRequest("only a YouTube channel has videos to list");
  const now = ctx.now();
  let added = 0;
  ctx.db.transaction(() => {
    const oldest = (ctx.db.prepare("SELECT MIN(published_at) AS t FROM episode WHERE feed_id = ?").get(feedId) as { t: number | null }).t ?? now;
    const insert = ctx.db.prepare(
      "INSERT INTO episode (id, feed_id, guid, title, description_html, published_at, first_seen_at, enclosure_url_enc, enclosure_type, enclosure_bytes, duration_hint_ms, image_url, link, chapters_url_enc, feed_chapters, media_kind, youtube_id, video_url_enc) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 'video/youtube', NULL, ?, ?, ?, NULL, NULL, 'video', ?, NULL)",
    );
    for (const v of videos) {
      if (!/^[A-Za-z0-9_-]{11}$/.test(v.youtube_id)) continue;
      const guid = `yt:video:${v.youtube_id}`;
      const existing = ctx.db.prepare("SELECT id FROM episode WHERE feed_id = ? AND guid = ?").pluck().get(feedId, guid) as string | undefined;
      if (existing) {
        if (v.duration_ms) ctx.db.prepare("UPDATE episode SET duration_hint_ms = COALESCE(duration_hint_ms, ?) WHERE id = ?").run(v.duration_ms, existing);
        continue;
      }
      added++;
      const link = `https://www.youtube.com/watch?v=${v.youtube_id}`;
      insert.run(newId(), feedId, guid, v.title, v.published_at ?? oldest - added * 1000, now, ctx.secrets.encrypt(link), v.duration_ms ?? null, v.thumbnail_url ?? `https://i.ytimg.com/vi/${v.youtube_id}/hqdefault.jpg`, link, v.youtube_id);
    }
    const wanted = ended ? 0 : Math.max(0, feed.listing_wanted - added);
    ctx.db.prepare("UPDATE feed SET listing_wanted = ?, listing_offset = listing_offset + ?, listing_ended = ?, listing_error = NULL WHERE id = ?").run(wanted, videos.length, ended ? 1 : 0, feedId);
  })();
  ctx.log("channel listed", { feed_id: feedId, walked: videos.length, added, ended });
  return { added, wanted: ended ? 0 : Math.max(0, feed.listing_wanted - added) };
}

/** The fetcher could not list the channel: the apps show why, and the button asks again. */
export function listingFailed(ctx: AppContext, feedId: string, message: string): void {
  getFeedRow(ctx, feedId);
  ctx.db.prepare("UPDATE feed SET listing_wanted = 0, listing_error = ? WHERE id = ?").run(message, feedId);
  ctx.log("channel listing failed", { feed_id: feedId, error: message });
}

export type WantedMetadata = { episode_id: string; youtube_id: string; title: string };

/** Channel videos whose details have not come yet, the most recently listed first. */
export function wantedMetadata(ctx: AppContext, limit = 10): WantedMetadata[] {
  return ctx.db
    .prepare(
      `SELECT e.id AS episode_id, e.youtube_id, e.title FROM episode e
       WHERE e.metadata_at IS NULL AND e.media_kind = 'video' AND e.youtube_id IS NOT NULL AND e.video_url_enc IS NULL
       ORDER BY e.first_seen_at DESC, COALESCE(e.published_at, 0) DESC LIMIT ?`,
    )
    .all(limit) as WantedMetadata[];
}

export type VideoMetadata = {
  title?: string | undefined;
  description?: string | null | undefined;
  duration_ms?: number | null | undefined;
  thumbnail_url?: string | null | undefined;
  published_at?: number | null | undefined;
  chapters?: ChapterPoint[] | undefined;
  /** The video cannot be read (private, removed): stop asking. */
  unavailable?: string | undefined;
};

/** A video's details. Only what the fetcher sent changes; chapters become the publisher's chapters. */
export function storeMetadata(ctx: AppContext, episodeId: string, m: VideoMetadata): void {
  getEpisodeRow(ctx, episodeId);
  const description = m.description ? sanitizeShowNotes(descriptionHtml(m.description)) : null;
  const chapters = m.chapters && m.chapters.length > 0 ? JSON.stringify(m.chapters) : null;
  ctx.db
    .prepare(
      `UPDATE episode SET title = COALESCE(?, title), description_html = COALESCE(?, description_html), duration_hint_ms = COALESCE(?, duration_hint_ms),
       image_url = COALESCE(?, image_url), published_at = COALESCE(?, published_at), feed_chapters = COALESCE(?, feed_chapters), metadata_at = ? WHERE id = ?`,
    )
    .run(m.title ?? null, description, m.duration_ms ?? null, m.thumbnail_url ?? null, m.published_at ?? null, chapters, ctx.now(), episodeId);
  if (m.unavailable) ctx.log("video details unavailable", { episode_id: episodeId, reason: m.unavailable });
}

export type WantedCaptions = { episode_id: string; youtube_id: string; title: string };

/** Videos that arrived without captions because fetching them failed, once their wait is over. */
export function wantedCaptions(ctx: AppContext, limit = 5): WantedCaptions[] {
  return ctx.db
    .prepare(
      `SELECT e.id AS episode_id, e.youtube_id, e.title FROM episode e JOIN audio_asset a ON a.id = e.current_asset_id
       WHERE e.captions_retry_at IS NOT NULL AND e.captions_retry_at <= ? AND e.youtube_id IS NOT NULL AND a.video_path IS NOT NULL AND a.transcript_id IS NULL
       ORDER BY e.captions_retry_at LIMIT ?`,
    )
    .all(ctx.now(), limit) as WantedCaptions[];
}

/**
 * Fetching the captions failed, though the video arrived. This never transcribes, because a passing 429 must not turn
 * into an ElevenLabs bill: the fetcher tries again later, and after the last try the owner can still press Transcribe.
 */
export function captionsLater(ctx: AppContext, episodeId: string, message: string): { retry_at: number | null } {
  const ep = getEpisodeRow(ctx, episodeId);
  const hours = CAPTION_RETRY_HOURS[ep.captions_tries];
  const retry_at = hours === undefined ? null : ctx.now() + hours * 60 * 60 * 1000;
  ctx.db.prepare("UPDATE episode SET captions_retry_at = ?, captions_tries = captions_tries + 1 WHERE id = ?").run(retry_at, episodeId);
  ctx.log("captions put off", { episode_id: episodeId, tries: ep.captions_tries + 1, retry_at, error: message });
  return { retry_at };
}
