import { moreVideosView, type MoreVideosView } from "./channelVideos.js";
import { unlink } from "node:fs/promises";
import type { AppContext } from "../app/context.js";
import { badRequest, conflict, notFound } from "../app/errors.js";
import { parseFeed } from "../core/feed/parse.js";
import { channelIdInPage, parseYouTubeFeed, youtubeChannelPage, youtubeIdIn } from "../core/feed/youtube.js";
import { refreshTextFeed } from "./publisherText.js";
import { fetchPendingFeedChapters } from "./chapters.js";
import type { EpisodeRow, FeedRow } from "../db/rows.js";
import { PRIORITY } from "../jobs/queue.js";
import { newId } from "../lib/ids.js";
import { redact, safeFetch } from "../lib/safeFetch.js";
import { sanitizeShowNotes } from "../lib/sanitize.js";
import { NonRetryable } from "../jobs/errors.js";

export type FeedView = {
  id: string;
  /** 'podcast' feeds have episodes with audio; 'text' feeds carry the same show's articles and attach to a podcast feed. */
  kind: "podcast" | "text" | "youtube" | "links";
  text_for_feed_id: string | null;
  title: string | null;
  author: string | null;
  image_url: string | null;
  site_url: string | null;
  language: string | null;
  is_private: boolean;
  auto_process: boolean;
  transcriber: string;
  keyterms: string[];
  backfill: number;
  last_refresh_at: number | null;
  last_error: string | null;
  more_videos: MoreVideosView;
  episode_count: number;
  created_at: number;
  followed: boolean;
};

export type AddFeedInput = { url: string; kind?: "podcast" | "text" | "youtube"; text_for_feed_id?: string; is_private?: boolean; auto_process?: boolean; keyterms?: string[]; backfill?: number; followed?: boolean };
export type UpdateFeedInput = Partial<Pick<AddFeedInput, "is_private" | "auto_process" | "keyterms" | "backfill" | "followed">> & { title?: string; transcriber?: "elevenlabs" | "whisper-local" };

const FEED_MAX_BYTES = 20 * 1024 * 1024;
/** YouTube answers some of its pages only to a browser's user agent. */
export const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

export function toFeedView(ctx: AppContext, row: FeedRow): FeedView {
  const count = (ctx.db.prepare("SELECT COUNT(*) AS n FROM episode WHERE feed_id = ?").get(row.id) as { n: number }).n;
  return {
    id: row.id,
    kind: row.kind,
    text_for_feed_id: row.text_for_feed_id,
    title: row.title,
    author: row.author,
    image_url: row.image_url,
    site_url: row.site_url,
    language: row.language,
    is_private: row.is_private === 1,
    auto_process: row.auto_process === 1,
    transcriber: row.transcriber,
    keyterms: JSON.parse(row.keyterms) as string[],
    backfill: row.backfill,
    last_refresh_at: row.last_refresh_at,
    last_error: row.last_error,
    episode_count: count,
    created_at: row.created_at,
    followed: row.followed === 1,
    more_videos: moreVideosView(row),
  };
}

export function addFeed(ctx: AppContext, input: AddFeedInput): FeedView {
  let url: URL;
  try {
    url = new URL(input.url.trim());
  } catch {
    throw badRequest("url is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw badRequest("url must be http or https");
  const normalized = url.toString();
  const hash = ctx.secrets.hash(normalized);
  const existing = ctx.db.prepare("SELECT id FROM feed WHERE url_hash = ?").pluck().get(hash) as string | undefined;
  if (existing) throw conflict("feed already added", { feed_id: existing });
  const kind = input.kind ?? (isYouTubeFeedUrl(url) ? "youtube" : "podcast");
  const isPrivate = kind === "youtube" ? false : (input.is_private ?? looksPrivate(url));
  if (kind === "youtube" && !isYouTubeFeedUrl(url)) throw badRequest("a youtube feed's url must be the channel's feed: https://www.youtube.com/feeds/videos.xml?channel_id=UC…; give a channel page to POST /v1/feeds and it is resolved");
  if (kind === "text") {
    if (!input.text_for_feed_id) throw badRequest("a text feed needs text_for_feed_id: the podcast feed whose episodes it describes");
    const target = ctx.db.prepare("SELECT kind FROM feed WHERE id = ?").get(input.text_for_feed_id) as { kind: string } | undefined;
    if (!target) throw notFound("podcast feed for text_for_feed_id");
    if (target.kind !== "podcast") throw badRequest("text_for_feed_id must name a podcast feed");
  }
  // A show opened without following is always manual: browsing one must never bill.
  const followed = input.followed !== false;
  // A channel's videos are fetched when the owner asks, unless asked for up front: a video is hours of download at home.
  const autoProcess = followed && (kind === "youtube" ? input.auto_process === true : input.auto_process !== false);
  const backfill = followed ? (input.backfill ?? 2) : 0;
  const id = newId();
  const now = ctx.now();
  ctx.db
    .prepare("INSERT INTO feed (id, url_enc, url_hash, is_private, auto_process, transcriber, keyterms, kind, text_for_feed_id, backfill, followed, created_at) VALUES (?, ?, ?, ?, ?, 'elevenlabs', ?, ?, ?, ?, ?, ?)")
    .run(id, ctx.secrets.encrypt(normalized), hash, isPrivate ? 1 : 0, autoProcess ? 1 : 0, JSON.stringify(input.keyterms ?? []), kind, kind === "text" ? input.text_for_feed_id : null, backfill, followed ? 1 : 0, now);
  ctx.queue.enqueue("refresh_feed", `refresh_feed:${id}`, { feed_id: id }, { priority: PRIORITY.play, rerun: true });
  return toFeedView(ctx, getFeedRow(ctx, id));
}

function isYouTubeFeedUrl(url: URL): boolean {
  return /(^|\.)youtube\.com$/.test(url.hostname) && url.pathname === "/feeds/videos.xml" && /^UC[A-Za-z0-9_-]{22}$/.test(url.searchParams.get("channel_id") ?? "");
}

/**
 * A YouTube channel page (`/@handle`, `/channel/UC…`) given as a feed URL becomes the channel's feed: the page is
 * read once for the channel id. Anything else passes through.
 */
export async function resolveFeedInput(ctx: AppContext, input: AddFeedInput): Promise<AddFeedInput> {
  const page = youtubeChannelPage(input.url.trim());
  if (!page) return input;
  const direct = page.match(/\/channel\/(UC[A-Za-z0-9_-]{22})$/)?.[1];
  let channelId = direct ?? null;
  if (!channelId) {
    const res = await safeFetch(page, { headers: { accept: "text/html", "accept-language": "en" }, maxBytes: 8 * 1024 * 1024, timeoutMs: 20_000, allowPrivateNetwork: ctx.config.allowPrivateNetwork });
    if (res.status !== 200) {
      await res.body?.cancel();
      throw badRequest(`the YouTube channel page returned ${res.status}`);
    }
    channelId = channelIdInPage(await new Response(res.body).text());
    if (!channelId) throw badRequest("could not find the channel's id on its page; give https://www.youtube.com/channel/UC… instead");
  }
  return { ...input, url: `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, kind: "youtube" };
}

/** Credentials in the URL, a query string, or a long mixed-case token as a path segment all mean "private". */
export function looksPrivate(url: URL): boolean {
  if (url.username !== "" || url.password !== "" || url.search !== "") return true;
  return url.pathname.split("/").some((seg) => /^[A-Za-z0-9_-]{16,}$/.test(seg) && /[A-Z]/.test(seg) && /[a-z0-9]/.test(seg));
}

export function getFeedRow(ctx: AppContext, id: string): FeedRow {
  const row = ctx.db.prepare("SELECT * FROM feed WHERE id = ?").get(id) as FeedRow | undefined;
  if (!row) throw notFound("feed");
  return row;
}

export function listFeeds(ctx: AppContext, opts: { followed?: boolean | undefined } = {}): FeedView[] {
  const where = opts.followed === undefined ? "" : `WHERE followed = ${opts.followed ? 1 : 0}`;
  const rows = ctx.db.prepare(`SELECT * FROM feed ${where} ORDER BY title COLLATE NOCASE, created_at`).all() as FeedRow[];
  return rows.map((r) => toFeedView(ctx, r));
}

/** Unfollowing a show also makes it manual, so a show outside the library never transcribes on its own. */
export function updateFeed(ctx: AppContext, id: string, patch: UpdateFeedInput): FeedView {
  const row = getFeedRow(ctx, id);
  const followed = patch.followed ?? row.followed === 1;
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.title !== undefined) { sets.push("title = ?"); args.push(patch.title); }
  if (patch.is_private !== undefined) { sets.push("is_private = ?"); args.push(patch.is_private ? 1 : 0); }
  if (patch.followed !== undefined) { sets.push("followed = ?"); args.push(patch.followed ? 1 : 0); }
  if (!followed) sets.push("auto_process = 0");
  else if (patch.auto_process !== undefined) { sets.push("auto_process = ?"); args.push(patch.auto_process ? 1 : 0); }
  if (patch.transcriber !== undefined) { sets.push("transcriber = ?"); args.push(patch.transcriber); }
  if (patch.keyterms !== undefined) { sets.push("keyterms = ?"); args.push(JSON.stringify(patch.keyterms)); }
  if (patch.backfill !== undefined) { sets.push("backfill = ?"); args.push(patch.backfill); }
  if (sets.length > 0) ctx.db.prepare(`UPDATE feed SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
  return toFeedView(ctx, getFeedRow(ctx, id));
}

/** Remove a feed and everything under it, unless a snip still references one of its recordings. */
export async function deleteFeed(ctx: AppContext, id: string): Promise<void> {
  getFeedRow(ctx, id);
  const snips = ctx.db.prepare("SELECT COUNT(*) AS n FROM snip s JOIN audio_asset a ON a.id = s.audio_asset_id JOIN episode e ON e.id = a.episode_id WHERE e.feed_id = ? AND s.deleted_at IS NULL").get(id) as { n: number };
  if (snips.n > 0) throw conflict(`feed has ${snips.n} snips; delete them first`);
  const files = ctx.db.prepare("SELECT a.path FROM audio_asset a JOIN episode e ON e.id = a.episode_id WHERE e.feed_id = ?").pluck().all(id) as string[];
  ctx.db.transaction(() => {
    ctx.db.prepare("UPDATE feed SET text_for_feed_id = NULL WHERE text_for_feed_id = ?").run(id);
    ctx.db.prepare("DELETE FROM playback_state WHERE audio_asset_id IN (SELECT a.id FROM audio_asset a JOIN episode e ON e.id = a.episode_id WHERE e.feed_id = ?)").run(id);
    ctx.db.prepare("UPDATE audio_asset SET transcript_id = NULL, summary_id = NULL WHERE episode_id IN (SELECT id FROM episode WHERE feed_id = ?)").run(id);
    ctx.db.prepare("DELETE FROM episode_summary WHERE transcript_id IN (SELECT t.id FROM transcript t JOIN audio_asset a ON a.id = t.audio_asset_id JOIN episode e ON e.id = a.episode_id WHERE e.feed_id = ?)").run(id);
    ctx.db.prepare("DELETE FROM transcript_segment WHERE transcript_id IN (SELECT t.id FROM transcript t JOIN audio_asset a ON a.id = t.audio_asset_id JOIN episode e ON e.id = a.episode_id WHERE e.feed_id = ?)").run(id);
    ctx.db.prepare("DELETE FROM transcript WHERE audio_asset_id IN (SELECT a.id FROM audio_asset a JOIN episode e ON e.id = a.episode_id WHERE e.feed_id = ?)").run(id);
    ctx.db.prepare("UPDATE episode SET current_asset_id = NULL WHERE feed_id = ?").run(id);
    ctx.db.prepare("DELETE FROM audio_asset WHERE episode_id IN (SELECT id FROM episode WHERE feed_id = ?)").run(id);
    ctx.db.prepare("DELETE FROM episode_text WHERE episode_id IN (SELECT id FROM episode WHERE feed_id = ?)").run(id);
    ctx.db.prepare("DELETE FROM episode WHERE feed_id = ?").run(id);
    ctx.db.prepare("DELETE FROM job WHERE key = ? OR key IN (SELECT 'fetch_audio:' || id FROM episode WHERE feed_id = ?)").run(`refresh_feed:${id}`, id);
    ctx.db.prepare("DELETE FROM feed WHERE id = ?").run(id);
  })();
  for (const f of files) {
    const stillUsed = ctx.db.prepare("SELECT 1 FROM audio_asset WHERE path = ? LIMIT 1").get(f);
    if (!stillUsed) await unlink(f).catch(() => undefined);
  }
}

export type RefreshReport = {
  feed_id: string;
  not_modified: boolean;
  new_episodes: number;
  skipped: { title: string | null; reason: string }[];
  enqueued_audio: number;
  /** Text feeds only. */
  texts?: { new: number; unmatched: string[]; align_enqueued: number };
};

/**
 * Fetch the feed with conditional headers, upsert episodes by identity, and enqueue audio work.
 * On the first import only the newest `backfill` items are processed; afterwards every new item is.
 */
/** Job body for `refresh_feed`. */
export async function refreshFeedJob(ctx: AppContext, job: { payload: { feed_id: string } }): Promise<RefreshReport> {
  return refreshFeed(ctx, job.payload.feed_id);
}

export async function refreshFeed(ctx: AppContext, feedId: string): Promise<RefreshReport> {
  const feed = getFeedRow(ctx, feedId);
  if (feed.kind === "text") return refreshTextFeed(ctx, feed);
  if (feed.kind === "youtube") return refreshYouTubeFeed(ctx, feed);
  // The Pasted links show (services/links.ts) has nothing to fetch: its episodes arrive one paste at a time.
  if (feed.kind === "links") return { feed_id: feedId, not_modified: true, new_episodes: 0, skipped: [], enqueued_audio: 0 };
  const fetched = await fetchFeedDocument(ctx, feed, parseFeed);
  if (!fetched) return { feed_id: feedId, not_modified: true, new_episodes: 0, skipped: [], enqueued_audio: 0 };
  const { doc: parsed, url } = fetched;

  const existing = new Set(ctx.db.prepare("SELECT guid FROM episode WHERE feed_id = ?").pluck().all(feedId) as string[]);
  const firstImport = existing.size === 0;
  const now = ctx.now();
  const inserted: EpisodeRow[] = [];
  ctx.db.transaction(() => {
    ctx.db
      .prepare("UPDATE feed SET title = COALESCE(?, title), author = COALESCE(?, author), image_url = COALESCE(?, image_url), site_url = COALESCE(?, site_url), language = COALESCE(?, language), etag = ?, last_modified = ?, last_refresh_at = ?, last_error = NULL WHERE id = ?")
      .run(parsed.feed.title, parsed.feed.author, parsed.feed.image_url, parsed.feed.site_url, parsed.feed.language, fetched.etag, fetched.lastModified, now, feedId);
    const insert = ctx.db.prepare(
      "INSERT INTO episode (id, feed_id, guid, title, description_html, published_at, first_seen_at, enclosure_url_enc, enclosure_type, enclosure_bytes, duration_hint_ms, image_url, link, chapters_url_enc, feed_chapters, media_kind, youtube_id, video_url_enc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    // An episode that was here before videos were: the video its notes link, or the feed's video file, is remembered now.
    const addVideo = ctx.db.prepare("UPDATE episode SET youtube_id = COALESCE(youtube_id, ?), video_url_enc = COALESCE(video_url_enc, ?) WHERE feed_id = ? AND guid = ? AND (youtube_id IS NULL OR video_url_enc IS NULL)");
    // Publishers often add chapters after an episode is out, so an existing episode picks up the first ones seen.
    const addChapters = ctx.db.prepare(
      "UPDATE episode SET chapters_url_enc = COALESCE(chapters_url_enc, ?), feed_chapters = COALESCE(feed_chapters, ?) WHERE feed_id = ? AND guid = ? AND (chapters_url_enc IS NULL OR feed_chapters IS NULL)",
    );
    for (const item of parsed.items) {
      const chaptersUrl = item.chapters_url ? ctx.secrets.encrypt(item.chapters_url) : null;
      const feedChapters = item.chapters ? JSON.stringify(item.chapters) : null;
      const youtubeId = youtubeIdIn(item.description_html);
      const videoUrl = item.video_url ? ctx.secrets.encrypt(item.video_url) : null;
      if (existing.has(item.identity)) {
        if (chaptersUrl || feedChapters) addChapters.run(chaptersUrl, feedChapters, feedId, item.identity);
        if (youtubeId || videoUrl) addVideo.run(youtubeId, videoUrl, feedId, item.identity);
        continue;
      }
      const id = newId();
      insert.run(id, feedId, item.identity, item.title, sanitizeShowNotes(item.description_html), item.published_at, now, ctx.secrets.encrypt(item.enclosure_url), item.enclosure_type, item.enclosure_bytes, item.duration_hint_ms, item.image_url, item.link, chaptersUrl, feedChapters, item.media_kind, youtubeId, videoUrl);
      inserted.push(ctx.db.prepare("SELECT * FROM episode WHERE id = ?").get(id) as EpisodeRow);
    }
  })();

  let enqueued = 0;
  if (feed.auto_process === 1 && inserted.length > 0) {
    const ordered = [...inserted].sort((a, b) => (b.published_at ?? 0) - (a.published_at ?? 0));
    const toProcess = firstImport ? ordered.slice(0, feed.backfill) : ordered;
    for (const ep of toProcess) {
      ctx.queue.enqueue("fetch_audio", `fetch_audio:${ep.id}`, { episode_id: ep.id, then: "transcribe" }, { priority: PRIORITY.catalog });
      enqueued++;
    }
  }
  // An article that arrived before its episode can be matched now rather than at the text feed's next turn.
  if (inserted.length > 0) {
    const textFeeds = ctx.db.prepare("SELECT id FROM feed WHERE kind = 'text' AND text_for_feed_id = ?").pluck().all(feedId) as string[];
    for (const id of textFeeds) ctx.queue.enqueue("refresh_feed", `refresh_feed:${id}`, { feed_id: id }, { priority: PRIORITY.catalog, rerun: true });
  }
  await fetchPendingFeedChapters(ctx, feedId);
  ctx.log("feed refreshed", { feed_id: feedId, url: redact(url), new_episodes: inserted.length, enqueued, skipped: parsed.skipped.length });
  return { feed_id: feedId, not_modified: false, new_episodes: inserted.length, skipped: parsed.skipped, enqueued_audio: enqueued };
}

/**
 * A YouTube channel's feed: its latest videos become episodes of kind video, each the YouTube video itself. Their
 * recordings come from the home fetcher when wanted (services/video.ts), so auto_process here means "fetch and
 * transcribe each new video" on the home connection, with YouTube's captions as the transcript.
 */
async function refreshYouTubeFeed(ctx: AppContext, feed: FeedRow): Promise<RefreshReport> {
  // YouTube answers its feeds endpoint with 404 to an unfamiliar user agent, and with the feed to a browser's.
  const fetched = await fetchFeedDocument(ctx, feed, parseYouTubeFeed, { accept: "application/atom+xml, application/xml, text/xml, */*", "user-agent": BROWSER_UA });
  if (!fetched) return { feed_id: feed.id, not_modified: true, new_episodes: 0, skipped: [], enqueued_audio: 0 };
  const { doc: parsed } = fetched;
  const existing = new Set(ctx.db.prepare("SELECT guid FROM episode WHERE feed_id = ?").pluck().all(feed.id) as string[]);
  const firstImport = existing.size === 0;
  const now = ctx.now();
  const inserted: EpisodeRow[] = [];
  ctx.db.transaction(() => {
    // The feed has no channel artwork; the newest video's thumbnail stands in until the owner sets one.
    const art = parsed.videos[0]?.thumbnail_url ?? null;
    ctx.db
      .prepare("UPDATE feed SET title = COALESCE(?, title), author = COALESCE(?, author), image_url = COALESCE(image_url, ?), site_url = COALESCE(?, site_url), etag = ?, last_modified = ?, last_refresh_at = ?, last_error = NULL WHERE id = ?")
      .run(parsed.channel.title, parsed.channel.author, art, parsed.channel.site_url, fetched.etag, fetched.lastModified, now, feed.id);
    const insert = ctx.db.prepare(
      "INSERT INTO episode (id, feed_id, guid, title, description_html, published_at, first_seen_at, enclosure_url_enc, enclosure_type, enclosure_bytes, duration_hint_ms, image_url, link, chapters_url_enc, feed_chapters, media_kind, youtube_id, video_url_enc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL, 'video', ?, NULL)",
    );
    for (const v of parsed.videos) {
      const guid = `yt:video:${v.video_id}`;
      if (existing.has(guid)) continue;
      const id = newId();
      insert.run(id, feed.id, guid, v.title, sanitizeShowNotes(descriptionHtml(v.description)), v.published_at, now, ctx.secrets.encrypt(v.link), "video/youtube", v.thumbnail_url, v.link, v.video_id);
      inserted.push(ctx.db.prepare("SELECT * FROM episode WHERE id = ?").get(id) as EpisodeRow);
    }
  })();
  let enqueued = 0;
  if (feed.auto_process === 1 && inserted.length > 0) {
    const ordered = [...inserted].sort((a, b) => (b.published_at ?? 0) - (a.published_at ?? 0));
    for (const ep of firstImport ? ordered.slice(0, feed.backfill) : ordered) {
      ctx.queue.enqueue("fetch_video", `fetch_video:${ep.id}`, { episode_id: ep.id }, { priority: PRIORITY.catalog });
      enqueued++;
    }
  }
  ctx.log("channel refreshed", { feed_id: feed.id, new_episodes: inserted.length, enqueued });
  return { feed_id: feed.id, not_modified: false, new_episodes: inserted.length, skipped: [], enqueued_audio: enqueued };
}

/** A video's plain-text description as show notes: paragraphs, with links kept clickable. */
/** A YouTube description (plain text with line breaks) as show notes: paragraphs, with its links made links. */
export function descriptionHtml(text: string | null): string | null {
  if (!text) return null;
  const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const linked = (s: string) => escape(s).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}">${u}</a>`);
  return text.split(/\n{2,}/).map((p) => `<p>${linked(p.trim()).replace(/\n/g, "<br>")}</p>`).join("");
}

/**
 * Fetch a feed's document with its conditional headers, noting on the feed anything that goes wrong. Null when the
 * feed has not changed (the refresh is noted); else the parsed document, the validators to store with it, and the
 * url for logging. A feed that is gone, refused, or will not parse does not retry; other failures do.
 */
export async function fetchFeedDocument<T>(ctx: AppContext, feed: FeedRow, parse: (xml: string) => T, extraHeaders: Record<string, string> = {}): Promise<{ doc: T; etag: string | null; lastModified: string | null; url: string } | null> {
  const url = ctx.secrets.decrypt(feed.url_enc);
  const headers: Record<string, string> = { accept: "application/rss+xml, application/xml, text/xml, */*", ...extraHeaders };
  if (feed.etag) headers["if-none-match"] = feed.etag;
  if (feed.last_modified) headers["if-modified-since"] = feed.last_modified;
  let res;
  try {
    res = await safeFetch(url, { headers, maxBytes: FEED_MAX_BYTES, timeoutMs: 30_000, allowPrivateNetwork: ctx.config.allowPrivateNetwork });
  } catch (err) {
    recordFeedError(ctx, feed.id, `fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
  if (res.status === 304) {
    await res.body?.cancel();
    ctx.db.prepare("UPDATE feed SET last_refresh_at = ?, last_error = NULL WHERE id = ?").run(ctx.now(), feed.id);
    return null;
  }
  if (res.status !== 200) {
    await res.body?.cancel();
    // YouTube intermittently returns 404 for valid channel feeds. Use the queue's bounded
    // backoff so a temporary upstream failure does not immediately fail the refresh.
    const transientNotFound = feed.kind === "youtube" && res.status === 404;
    const final = res.status === 401 || res.status === 403 || (res.status === 404 && !transientNotFound) || res.status === 410;
    recordFeedError(ctx, feed.id, res.status === 401 || res.status === 403 ? "credential rejected (401/403); the private feed link may have expired" : res.status === 404 || res.status === 410 ? `feed not found (${res.status})` : `unexpected status ${res.status}`);
    if (final) throw new NonRetryable(`feed returned ${res.status}`);
    throw new Error(`feed returned ${res.status}`);
  }
  const xml = await new Response(res.body).text();
  try {
    return { doc: parse(xml), etag: res.headers.get("etag"), lastModified: res.headers.get("last-modified"), url };
  } catch (err) {
    recordFeedError(ctx, feed.id, `parse failed: ${err instanceof Error ? err.message : String(err)}`);
    throw new NonRetryable("feed did not parse");
  }
}

export function recordFeedError(ctx: AppContext, feedId: string, message: string): void {
  ctx.db.prepare("UPDATE feed SET last_error = ?, last_refresh_at = ? WHERE id = ?").run(message, ctx.now(), feedId);
}

export type RefreshRunView = { run_id: string; status: "queued" | "running" | "done" | "failed"; feeds: number; jobs: { feed_id: string; status: string; last_error: string | null }[]; created_at: number };

/** The feeds a scheduled or "refresh everything" run refreshes. Unfollowed shows (opened from search) refresh only when
 * asked for one by one: POST /v1/feeds/{id}/refresh. */
export function scheduledFeedIds(ctx: AppContext): string[] {
  return ctx.db.prepare("SELECT id FROM feed WHERE followed = 1").pluck().all() as string[];
}

/** Enqueue a refresh of every followed feed under an idempotency key; replaying the key returns the same run. */
export function requestRefreshRun(ctx: AppContext, key: string): RefreshRunView {
  const settingKey = `refresh_run:${key}`;
  const existing = ctx.db.prepare("SELECT value FROM setting WHERE key = ?").get(settingKey) as { value: string } | undefined;
  if (existing) return getRefreshRun(ctx, key);
  const feeds = scheduledFeedIds(ctx);
  const jobIds: Record<string, string> = {};
  for (const feedId of feeds) jobIds[feedId] = ctx.queue.enqueue("refresh_feed", `refresh_feed:${feedId}`, { feed_id: feedId, run_id: key }, { rerun: true }).id;
  ctx.db.prepare("INSERT INTO setting (key, value) VALUES (?, ?)").run(settingKey, JSON.stringify({ jobs: jobIds, created_at: ctx.now() }));
  return getRefreshRun(ctx, key);
}

export function getRefreshRun(ctx: AppContext, key: string): RefreshRunView {
  const row = ctx.db.prepare("SELECT value FROM setting WHERE key = ?").get(`refresh_run:${key}`) as { value: string } | undefined;
  if (!row) throw notFound("refresh run");
  const saved = JSON.parse(row.value) as { jobs: Record<string, string>; created_at: number };
  const jobs = Object.entries(saved.jobs).map(([feed_id, jobId]) => {
    const job = ctx.queue.get(jobId);
    return { feed_id, status: job?.status ?? "done", last_error: job?.last_error ?? null };
  });
  const status = jobs.some((j) => j.status === "running") ? "running" : jobs.some((j) => j.status === "queued") ? "queued" : jobs.some((j) => j.status === "failed") ? "failed" : "done";
  return { run_id: key, status, feeds: jobs.length, jobs, created_at: saved.created_at };
}
