/**
 * Pasted links (docs/video-plan.md, "One-off links"): a link to a video or audio file, pasted into the show search or
 * shared from another app, becomes a one-off episode of the "Pasted links" show. That show exists for these alone: it
 * is made on the first paste, has nothing to refresh, is no subscription, and is followed so its episodes sit in
 * Library and Today like any show's. The server downloads the file itself (the fetch_audio job, which keeps a video
 * with its audio pulled out beside it) and then transcribes it, which bills. A YouTube video link is handled as
 * POST /v1/youtube/episodes would, since its file comes from the home fetcher. A link to a web page (an x.com post,
 * say) is refused with a message: getting the file out of a page needs yt-dlp, which only the home fetcher has.
 */
import type { AppContext } from "../app/context.js";
import { badRequest } from "../app/errors.js";
import { youtubeChannelPage, youtubeIdFrom } from "../core/feed/youtube.js";
import { PRIORITY } from "../jobs/queue.js";
import { newId } from "../lib/ids.js";
import { redact, safeFetch } from "../lib/safeFetch.js";
import { sanitizeShowNotes } from "../lib/sanitize.js";
import { ensureAudio, getEpisode, type EpisodeDetail } from "./episodes.js";
import { BROWSER_UA, descriptionHtml } from "./feeds.js";
import { addYouTubeVideo } from "./video.js";

/** The links show's url: a feed row needs one, and nothing fetches it. */
export const PASTED_LINKS_URL = "snip:pasted-links";
export const PASTED_LINKS_TITLE = "Pasted links";

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv)$/i;
const AUDIO_EXT = /\.(mp3|m4a|m4b|aac|ogg|oga|opus|wav|flac|wma)$/i;
/** The one-off's file, as far as the link's headers say. */
export type LinkProbe = { media_kind: "audio" | "video"; type: string; bytes: number | null; filename: string | null };

/** The links show, made on first use: followed (in Library and Today), automatic (its episodes transcribe on arrival anyway), never refreshed. */
export function pastedLinksFeed(ctx: AppContext): string {
  const existing = ctx.db.prepare("SELECT id FROM feed WHERE kind = 'links' LIMIT 1").pluck().get() as string | undefined;
  if (existing) return existing;
  const id = newId();
  const now = ctx.now();
  // last_refresh_at is set so the apps never wait for a first refresh that will not come.
  ctx.db
    .prepare("INSERT INTO feed (id, url_enc, url_hash, is_private, auto_process, transcriber, keyterms, kind, text_for_feed_id, backfill, followed, title, last_refresh_at, created_at) VALUES (?, ?, ?, 0, 1, 'elevenlabs', '[]', 'links', NULL, 0, 1, ?, ?, ?)")
    .run(id, ctx.secrets.encrypt(PASTED_LINKS_URL), ctx.secrets.hash(PASTED_LINKS_URL), PASTED_LINKS_TITLE, now, now);
  ctx.log("pasted links show created", { feed_id: id });
  return id;
}

/**
 * A pasted link becomes a one-off episode, downloaded and transcribed at once. The same link twice is the same
 * episode (asked for again if its download failed). A YouTube video link is the channel's episode, as
 * `addYouTubeVideo` makes it.
 */
export async function addPastedLink(ctx: AppContext, input: { url: string; title?: string | undefined }, deviceId: string): Promise<EpisodeDetail> {
  const raw = input.url.trim();
  if (youtubeIdFrom(raw)) return addYouTubeVideo(ctx, raw, deviceId);
  if (youtubeChannelPage(raw)) throw badRequest("that is a YouTube channel, not a video: add it as a show");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest("not a link");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw badRequest("the link must be http or https");
  const normalized = url.toString();
  const feedId = pastedLinksFeed(ctx);
  const guid = `link:${ctx.secrets.hash(normalized)}`;
  const existing = ctx.db.prepare("SELECT id FROM episode WHERE feed_id = ? AND guid = ?").pluck().get(feedId, guid) as string | undefined;
  if (existing) {
    ensureAudio(ctx, existing, PRIORITY.play, "transcribe");
    return getEpisode(ctx, existing, deviceId);
  }
  const probe = await probeLink(ctx, normalized);
  const title = (input.title?.trim() || titleFor(url, probe)).slice(0, 300);
  const id = newId();
  const now = ctx.now();
  ctx.db
    .prepare(
      "INSERT INTO episode (id, feed_id, guid, title, description_html, published_at, first_seen_at, enclosure_url_enc, enclosure_type, enclosure_bytes, duration_hint_ms, image_url, link, chapters_url_enc, feed_chapters, media_kind, youtube_id, video_url_enc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, ?, NULL, NULL)",
    )
    .run(id, feedId, guid, title, sanitizeShowNotes(descriptionHtml(normalized)), now, now, ctx.secrets.encrypt(normalized), probe.type || null, probe.bytes, normalized, probe.media_kind);
  ctx.queue.enqueue("fetch_audio", `fetch_audio:${id}`, { episode_id: id, then: "transcribe" }, { priority: PRIORITY.play });
  ctx.log("pasted link added", { episode_id: id, media_kind: probe.media_kind, type: probe.type, bytes: probe.bytes, url: redact(normalized) });
  return getEpisode(ctx, id, deviceId);
}

/**
 * What the link points at, from its headers alone (one byte is asked for; a server that ignores the range sends
 * headers and the body is dropped unread). A web page or a feed is refused here, before any row is made; a file
 * whose type the server does not name is taken for a video, which the download corrects if it is audio.
 */
export async function probeLink(ctx: AppContext, url: string): Promise<LinkProbe> {
  let res;
  try {
    res = await safeFetch(url, {
      headers: { accept: "video/*,audio/*,*/*", range: "bytes=0-0", "user-agent": BROWSER_UA },
      timeoutMs: 20_000,
      maxHeaderSize: 64 * 1024,
      allowPrivateNetwork: ctx.config.allowPrivateNetwork,
    });
  } catch (err) {
    throw badRequest(`could not reach the link: ${err instanceof Error ? err.message : String(err)}`);
  }
  await res.body?.cancel();
  if (res.status !== 200 && res.status !== 206) throw badRequest(`the link returned ${res.status}`);
  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const path = new URL(res.finalUrl).pathname;
  if (type === "text/html" || type === "application/xhtml+xml") {
    throw badRequest("that is a web page, not a video file. Paste the address of the file itself (it usually ends in .mp4), or a YouTube link");
  }
  if (/\b(rss|atom|xml|json)\b/.test(type)) throw badRequest("that is a feed, not a video file: add it as a show instead");
  const media_kind: LinkProbe["media_kind"] | null =
    type.startsWith("video/") || VIDEO_EXT.test(path) ? "video"
    : type.startsWith("audio/") || AUDIO_EXT.test(path) ? "audio"
    : type === "" || type === "application/octet-stream" || type === "binary/octet-stream" ? "video"
    : null;
  if (!media_kind) throw badRequest(`the link is not a video or audio file (it is ${type})`);
  const total = res.headers.get("content-range")?.match(/\/(\d+)\s*$/)?.[1] ?? (res.status === 200 ? res.headers.get("content-length") : null);
  const bytes = total !== null && total !== undefined && /^\d+$/.test(total) ? Number(total) : null;
  const disposition = res.headers.get("content-disposition") ?? "";
  const starred = disposition.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/)?.[1];
  const plain = disposition.match(/filename\s*=\s*"?([^";]+)"?/)?.[1];
  let filename: string | null = null;
  try {
    filename = (starred ? decodeURIComponent(starred) : plain ?? "").trim() || null;
  } catch {
    filename = plain?.trim() || null;
  }
  return { media_kind, type, bytes, filename };
}

/**
 * The episode's title when the owner gave none: the file's name when it reads like one (a word, or words joined by
 * spaces, dashes or underscores), else where the file came from, since a CDN's random file name says nothing.
 */
export function titleFor(url: URL, probe: Pick<LinkProbe, "media_kind" | "filename">): string {
  const last = probe.filename ?? decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "");
  const stem = last.replace(/\.[A-Za-z0-9]{1,5}$/, "").trim();
  const readable = /^[A-Za-z][A-Za-z0-9]*$/.test(stem) ? stem.length <= 12 || /^[a-z]+$/.test(stem) : /^[\w .'()&-]{2,120}$/.test(stem) && /[ _-]/.test(stem);
  if (stem && readable) return stem.replace(/[_]+/g, " ");
  const host = url.hostname.replace(/^www\./, "");
  return `${probe.media_kind === "video" ? "Video" : "Audio"} from ${host}`;
}
