/**
 * Video (docs/video-plan.md). A video is a recording with a picture: an audio_asset whose `video_path` holds the
 * video file and whose `path` holds the audio pulled out of it, on one timeline, so everything built on the audio
 * (transcripts, snips, ad breaks, heard tracking) works unchanged.
 *
 * Asking for an episode's video is a `fetch_video` job, whatever the source. A feed's own video file
 * (`episode.video_url_enc`, or a video-only enclosure) the job downloads itself, like audio. A YouTube video
 * (`episode.youtube_id`) the server never fetches: the job parks itself, and the home fetcher (fetcher/README.md)
 * polls for parked jobs, downloads the video and its captions on the home connection, and uploads them here
 * (`storeVideoFile`, `storeCaptions`, `videoDone`). The job's state is the video's state for the apps, and its
 * message is why a fetch failed.
 *
 * Storing a video makes it the episode's current recording. For a podcast episode this switches the episode to its
 * video version (its own timeline); snips and progress on the audio version stay on that recording, which keeps its
 * rows.
 */
import { execFile } from "node:child_process";
import { mkdir, rename, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AppContext } from "../app/context.js";
import { badRequest, conflict } from "../app/errors.js";
import { parseWatchPage, youtubeIdFrom } from "../core/feed/youtube.js";
import { captionsToTranscript, type CaptionsMeta, type Json3 } from "../core/transcript/captions.js";
import { normalize } from "../core/transcript/normalize.js";
import type { AudioAssetRow, EpisodeRow } from "../db/rows.js";
import { DeferJob, NonRetryable } from "../jobs/errors.js";
import { PRIORITY, type Job } from "../jobs/queue.js";
import { probeAudio } from "../lib/ffprobe.js";
import { hashFile } from "../lib/hash.js";
import { newId } from "../lib/ids.js";
import { downloadToFile, redact, safeFetch } from "../lib/safeFetch.js";
import { sanitizeShowNotes } from "../lib/sanitize.js";
import { fetchFeedChapters } from "./chapters.js";
import { addFeed, BROWSER_UA, descriptionHtml } from "./feeds.js";
import { getAssetRow, getEpisode, getEpisodeRow } from "./episodes.js";
import { carryPlace, resumeFor } from "./playback.js";
import { storeTranscript } from "./transcripts.js";

const execFileAsync = promisify(execFile);
const jobKey = (episodeId: string) => `fetch_video:${episodeId}`;

/** Where an episode's video stands, for the apps: from the recording, else from the fetch_video job. */
export type VideoStatus = "none" | "available" | "requested" | "ready" | "failed";
export type VideoView = { status: VideoStatus; error: string | null };

export function hasVideoSource(ep: Pick<EpisodeRow, "youtube_id" | "video_url_enc" | "media_kind">): boolean {
  return ep.youtube_id !== null || ep.video_url_enc !== null || ep.media_kind === "video";
}

/** A channel's video: its only recording is the YouTube video, which the home fetcher brings. */
export function fromHomeFetcher(ep: Pick<EpisodeRow, "youtube_id" | "video_url_enc" | "media_kind">): boolean {
  return ep.media_kind === "video" && ep.youtube_id !== null && ep.video_url_enc === null;
}

export function videoView(ctx: AppContext, ep: EpisodeRow, asset: Pick<AudioAssetRow, "video_path"> | null): VideoView {
  if (asset?.video_path) return { status: "ready", error: null };
  const job = ctx.queue.byKey(jobKey(ep.id));
  if (job?.status === "failed") return { status: "failed", error: job.last_error };
  if (job && job.status !== "done") return { status: "requested", error: null };
  return { status: hasVideoSource(ep) ? "available" : "none", error: null };
}

/**
 * The owner names the episode's YouTube video (its notes linked one that was taken down, or none): the next request
 * for the video fetches this one. Null forgets the link.
 */
export function setYouTubeVideo(ctx: AppContext, episodeId: string, youtubeId: string | null): void {
  const ep = getEpisodeRow(ctx, episodeId);
  if (youtubeId !== null && !/^[A-Za-z0-9_-]{11}$/.test(youtubeId)) throw badRequest("youtube_id must be the 11-character id of a YouTube video");
  if (ep.media_kind === "video" && ep.youtube_id && !ep.video_url_enc && youtubeId === null) throw badRequest("a channel's video is its YouTube video; it cannot be forgotten");
  ctx.db.prepare("UPDATE episode SET youtube_id = ? WHERE id = ?").run(youtubeId, episodeId);
  // A fetch that failed on the old video is not this video's failure.
  const job = ctx.queue.byKey(jobKey(episodeId));
  if (job?.status === "failed") ctx.db.prepare("DELETE FROM job WHERE id = ?").run(job.id);
}

/** The owner asked for the video (Watch video, opening a channel's video, a download): a fetch_video job. */
export function requestVideo(ctx: AppContext, episodeId: string, priority: number = PRIORITY.play): void {
  const ep = getEpisodeRow(ctx, episodeId);
  if (!hasVideoSource(ep)) throw badRequest("this episode has no video");
  ctx.queue.enqueue("fetch_video", jobKey(episodeId), { episode_id: episodeId }, { priority });
}

/**
 * A YouTube video the owner pasted becomes an episode, and its video is asked for at once. A video some episode
 * already names (a podcast episode's own video, say) is that episode. Any other is read from its watch page and
 * becomes an episode of its channel's show, which is created unfollowed when the library lacks it: its videos play,
 * transcribe and snip, but it stays out of Library and Today until followed from its page.
 */
export async function addYouTubeVideo(ctx: AppContext, url: string, deviceId: string): Promise<ReturnType<typeof getEpisode>> {
  const videoId = youtubeIdFrom(url.trim());
  if (!videoId) throw badRequest("not a link to a YouTube video");
  const linked = ctx.db.prepare("SELECT id FROM episode WHERE youtube_id = ? ORDER BY first_seen_at LIMIT 1").pluck().get(videoId) as string | undefined;
  if (linked) {
    requestVideo(ctx, linked);
    return getEpisode(ctx, linked, deviceId);
  }
  const res = await safeFetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: { accept: "text/html", "accept-language": "en", "user-agent": BROWSER_UA },
    maxBytes: 8 * 1024 * 1024,
    maxHeaderSize: 256 * 1024,
    timeoutMs: 20_000,
    allowPrivateNetwork: ctx.config.allowPrivateNetwork,
  });
  if (res.status !== 200) {
    await res.body?.cancel();
    throw badRequest(`the video's page returned ${res.status}`);
  }
  const watch = parseWatchPage(await new Response(res.body).text(), videoId);
  if (!watch) throw badRequest("could not read the video's page; is the video public?");
  const feedUrl = new URL(`https://www.youtube.com/feeds/videos.xml?channel_id=${watch.channel_id}`).toString();
  let feedId = ctx.db.prepare("SELECT id FROM feed WHERE url_hash = ?").pluck().get(ctx.secrets.hash(feedUrl)) as string | undefined;
  if (!feedId) feedId = addFeed(ctx, { url: feedUrl, kind: "youtube", followed: false }).id;
  // The page names the channel; the feed's own refresh fills in the rest when it runs.
  ctx.db.prepare("UPDATE feed SET title = COALESCE(title, ?), author = COALESCE(author, ?), image_url = COALESCE(image_url, ?) WHERE id = ?").run(watch.channel_name, watch.channel_name, watch.thumbnail_url, feedId);
  const guid = `yt:video:${videoId}`;
  let episodeId = ctx.db.prepare("SELECT id FROM episode WHERE feed_id = ? AND guid = ?").pluck().get(feedId, guid) as string | undefined;
  if (!episodeId) {
    episodeId = newId();
    ctx.db
      .prepare(
        "INSERT INTO episode (id, feed_id, guid, title, description_html, published_at, first_seen_at, enclosure_url_enc, enclosure_type, enclosure_bytes, duration_hint_ms, image_url, link, chapters_url_enc, feed_chapters, media_kind, youtube_id, video_url_enc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'video/youtube', NULL, ?, ?, ?, NULL, NULL, 'video', ?, NULL)",
      )
      .run(episodeId, feedId, guid, watch.title, sanitizeShowNotes(descriptionHtml(watch.description)), watch.published_at, ctx.now(), ctx.secrets.encrypt(watch.link), watch.duration_ms, watch.thumbnail_url, watch.link, videoId);
  }
  requestVideo(ctx, episodeId);
  return getEpisode(ctx, episodeId, deviceId);
}

export type WantedVideo = { episode_id: string; youtube_id: string; title: string; show_title: string | null; requested_at: number };

/** YouTube videos with a fetch_video job waiting on the home fetcher, the owner's most wanted first. */
export function wantedVideos(ctx: AppContext, limit = 20): WantedVideo[] {
  return ctx.db
    .prepare(
      `SELECT e.id AS episode_id, e.youtube_id, e.title, f.title AS show_title, j.created_at AS requested_at
       FROM job j
       JOIN episode e ON e.id = json_extract(j.payload, '$.episode_id')
       JOIN feed f ON f.id = e.feed_id
       LEFT JOIN audio_asset a ON a.id = e.current_asset_id
       WHERE j.kind = 'fetch_video' AND j.status IN ('queued', 'running', 'deferred')
         AND e.youtube_id IS NOT NULL AND e.video_url_enc IS NULL AND a.video_path IS NULL
       ORDER BY j.priority DESC, j.created_at ASC LIMIT ?`,
    )
    .all(limit) as WantedVideo[];
}

/** The fetcher could not get the video: the job fails with its message, until the owner asks again. */
export function videoFailed(ctx: AppContext, episodeId: string, message: string): void {
  getEpisodeRow(ctx, episodeId);
  const job = ctx.queue.byKey(jobKey(episodeId));
  if (job && job.status !== "done") ctx.queue.fail(job.id, message, { retryable: false });
  ctx.log("video failed", { episode_id: episodeId, error: message });
}

/**
 * A video file (on disk, just uploaded or downloaded) becomes the episode's recording: the file is kept
 * content-addressed, its audio is pulled out beside it, and the episode's current recording moves to the new asset.
 * The same video twice is stored once. Returns the asset.
 */
export async function storeVideoFile(ctx: AppContext, episodeId: string, tmpPath: string): Promise<AudioAssetRow> {
  const ep = getEpisodeRow(ctx, episodeId);
  const probe = await probeAudio(tmpPath);
  if (!probe.video) throw badRequest("the file is not a video");
  if (probe.mime !== "video/mp4") throw badRequest(`only MP4 video is accepted (this is ${probe.mime})`);
  const videoSha = await hashFile(tmpPath);
  const already = ctx.db.prepare("SELECT * FROM audio_asset WHERE episode_id = ? AND video_sha256 = ?").get(episodeId, videoSha) as AudioAssetRow | undefined;
  if (already) {
    await rm(tmpPath, { force: true });
    settle(ctx, ep, already);
    return already;
  }
  await mkdir(ctx.paths.assets, { recursive: true });
  const audioTmp = join(ctx.paths.tmp, `${newId()}.audio`);
  try {
    // The audio track as it is when it is AAC (the usual case; nothing lost), else re-encoded to MP3.
    const copy = probe.codec === "aac";
    await execFileAsync("ffmpeg", ["-v", "error", "-y", "-i", tmpPath, "-vn", ...(copy ? ["-c:a", "copy", "-f", "mp4"] : ["-c:a", "libmp3lame", "-q:a", "2", "-f", "mp3"]), audioTmp], { maxBuffer: 1024 * 1024 });
    const audio = await probeAudio(audioTmp);
    const audioSha = await hashFile(audioTmp);
    // The recording whose video was dropped, fetched again: the same audio is the same timeline, so it gets its video
    // back and keeps its transcript, its place and its snips.
    const dropped = ctx.db.prepare("SELECT * FROM audio_asset WHERE episode_id = ? AND sha256 = ? AND video_path IS NULL ORDER BY created_at DESC LIMIT 1").get(episodeId, audioSha) as AudioAssetRow | undefined;
    if (dropped) {
      const videoPath = join(ctx.paths.assets, `${videoSha}.mp4`);
      await rm(audioTmp, { force: true });
      await rename(tmpPath, videoPath);
      ctx.db
        .prepare("UPDATE audio_asset SET video_path = ?, video_sha256 = ?, video_bytes = ?, video_width = ?, video_height = ?, video_last_played_at = ? WHERE id = ?")
        .run(videoPath, videoSha, probe.bytes, probe.video.width, probe.video.height, ctx.now(), dropped.id);
      settle(ctx, ep, dropped);
      ctx.log("video restored", { episode_id: ep.id, asset_id: dropped.id, video_bytes: probe.bytes });
      await pruneVideosToCap(ctx);
      return getAssetRow(ctx, dropped.id);
    }
    const audioPath = join(ctx.paths.assets, `${audioSha}${copy ? ".m4a" : ".mp3"}`);
    const videoPath = join(ctx.paths.assets, `${videoSha}.mp4`);
    await rename(audioTmp, audioPath);
    await rename(tmpPath, videoPath);
    const asset: AudioAssetRow = {
      id: newId(), episode_id: ep.id, sha256: audioSha, bytes: audio.bytes, duration_ms: audio.duration_ms, mime: audio.mime, path: audioPath,
      transcript_id: null, summary_id: null, pinned: 0, created_at: ctx.now(),
      video_path: videoPath, video_sha256: videoSha, video_bytes: probe.bytes, video_width: probe.video.width, video_height: probe.video.height, video_last_played_at: null,
    };
    ctx.db
      .prepare(
        `INSERT INTO audio_asset (id, episode_id, sha256, bytes, duration_ms, mime, path, pinned, created_at, video_path, video_sha256, video_bytes, video_width, video_height)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
      )
      .run(asset.id, asset.episode_id, asset.sha256, asset.bytes, asset.duration_ms, asset.mime, asset.path, asset.created_at, asset.video_path, asset.video_sha256, asset.video_bytes, asset.video_width, asset.video_height);
    settle(ctx, ep, asset);
    // Publisher text is timed against one recording, and this one has its own timeline.
    const texts = ctx.db.prepare("SELECT id FROM episode_text WHERE episode_id = ?").pluck().all(ep.id) as string[];
    for (const textId of texts) ctx.queue.enqueue("align_text", `align_text:${textId}`, { text_id: textId }, { priority: PRIORITY.catalog, rerun: true });
    ctx.log("video stored", { episode_id: ep.id, asset_id: asset.id, video_bytes: probe.bytes, size: `${probe.video.width}x${probe.video.height}`, duration_ms: audio.duration_ms });
    await fetchFeedChapters(ctx, ep.id);
    await pruneVideosToCap(ctx);
    return asset;
  } catch (err) {
    await rm(audioTmp, { force: true });
    await rm(tmpPath, { force: true });
    throw err;
  }
}

/** Delete a video file unless another recording (identical bytes, content-addressed) still names it. */
async function unlinkUnlessShared(ctx: AppContext, path: string): Promise<void> {
  const shared = ctx.db.prepare("SELECT 1 FROM audio_asset WHERE video_path = ? LIMIT 1").get(path);
  if (!shared) await unlink(path).catch(() => undefined);
}

// MARK: Pruning

/** A finished episode's video is dropped this long after the report, unless it is played again meanwhile. */
export const PRUNE_AFTER_FINISHED_MS = 24 * 60 * 60 * 1000;
/** A video fetched or played this recently is never dropped for the cap: the owner asked for it and has not had it long. */
const PRUNE_GRACE_MS = 24 * 60 * 60 * 1000;

/** A finished report on a recording with a video: a prune_video job for a day later (each finish sets it again). */
export function scheduleVideoPrune(ctx: AppContext, assetId: string): void {
  const asset = ctx.db.prepare("SELECT video_path FROM audio_asset WHERE id = ?").get(assetId) as { video_path: string | null } | undefined;
  if (!asset?.video_path) return;
  ctx.queue.enqueue("prune_video", `prune_video:${assetId}`, { asset_id: assetId }, { runAfter: ctx.now() + PRUNE_AFTER_FINISHED_MS, rerun: true });
}

/**
 * Job body, a day after an episode was finished: drop its video file if it is still finished (not played again since,
 * on any device) and not pinned. The audio, the transcript and the snips stay; "Watch video" fetches it again.
 */
export async function pruneVideoJob(ctx: AppContext, job: Job<{ asset_id: string }>): Promise<void> {
  const asset = ctx.db.prepare("SELECT * FROM audio_asset WHERE id = ?").get(job.payload.asset_id) as AudioAssetRow | undefined;
  if (!asset?.video_path || asset.pinned === 1) return;
  if (!resumeFor(ctx, asset.id)?.finished) {
    ctx.log("video kept", { asset_id: asset.id, reason: "played again since it was finished" });
    return;
  }
  await dropVideo(ctx, asset, "finished");
}

/** Keep the video store under its cap: the least recently played goes first, never one fetched in the last day. */
export async function pruneVideosToCap(ctx: AppContext): Promise<void> {
  let total = (ctx.db.prepare("SELECT COALESCE(SUM(video_bytes), 0) AS n FROM audio_asset WHERE video_path IS NOT NULL").get() as { n: number }).n;
  const cap = ctx.config.videoStoreMaxBytes;
  if (total <= cap) return;
  const candidates = ctx.db
    .prepare("SELECT * FROM audio_asset WHERE video_path IS NOT NULL AND pinned = 0 AND COALESCE(video_last_played_at, created_at) < ? AND created_at < ? ORDER BY COALESCE(video_last_played_at, created_at) ASC")
    .all(ctx.now() - PRUNE_GRACE_MS, ctx.now() - PRUNE_GRACE_MS) as AudioAssetRow[];
  for (const asset of candidates) {
    if (total <= cap) break;
    await dropVideo(ctx, asset, "over the cap");
    total -= asset.video_bytes ?? 0;
  }
  if (total > cap) ctx.log("video store over its cap", { bytes: total, cap });
}

async function dropVideo(ctx: AppContext, asset: AudioAssetRow, reason: string): Promise<void> {
  const path = asset.video_path!;
  ctx.db.prepare("UPDATE audio_asset SET video_path = NULL, video_sha256 = NULL, video_bytes = NULL, video_width = NULL, video_height = NULL, video_last_played_at = NULL WHERE id = ?").run(asset.id);
  await unlinkUnlessShared(ctx, path);
  ctx.log("video dropped", { asset_id: asset.id, episode_id: asset.episode_id, bytes: asset.video_bytes, reason });
}

/** The episode now plays from this asset, your place comes with it if it is the same cut, and the jobs parked on its arrival (its own, and the audio fetch) go on. */
function settle(ctx: AppContext, ep: EpisodeRow, asset: AudioAssetRow): void {
  const previous = ctx.db.prepare("SELECT current_asset_id FROM episode WHERE id = ?").pluck().get(ep.id) as string | null;
  if (previous && previous !== asset.id) carryPlace(ctx, previous, asset.id);
  ctx.db.prepare("UPDATE episode SET current_asset_id = ? WHERE id = ?").run(asset.id, ep.id);
  ctx.queue.wake(jobKey(ep.id));
  ctx.queue.wake(`fetch_audio:${ep.id}`);
}

/**
 * A video's captions become its transcript (core/transcript/captions.ts). They attach to the episode's current
 * recording, which must be a video. A recording that already has a transcript keeps it; the captions are stored
 * alongside for comparison.
 */
export function storeCaptions(ctx: AppContext, episodeId: string, json: Json3, meta: CaptionsMeta): { transcript_id: string; word_count: number; current: boolean } {
  const ep = getEpisodeRow(ctx, episodeId);
  const asset = ep.current_asset_id ? getAssetRow(ctx, ep.current_asset_id) : null;
  if (!asset?.video_path) throw conflict("the episode's video has not arrived; upload the video before its captions");
  const raw = captionsToTranscript(json, meta);
  if (raw.words.length === 0) throw badRequest("the captions have no words");
  const normalized = normalize(raw, { duration_ms: asset.duration_ms });
  const current = asset.transcript_id === null;
  const row = storeTranscript(ctx, asset.id, normalized, { source: "captions", make_current: current });
  ctx.log("captions stored", { episode_id: ep.id, asset_id: asset.id, transcript_id: row.id, words: normalized.word_count, kind: meta.kind, current });
  return { transcript_id: row.id, word_count: normalized.word_count, current };
}

/** The fetcher has sent everything it had: a video without captions is transcribed, at the owner's priority. */
export function videoDone(ctx: AppContext, episodeId: string): void {
  const ep = getEpisodeRow(ctx, episodeId);
  const asset = ep.current_asset_id ? getAssetRow(ctx, ep.current_asset_id) : null;
  if (!asset?.video_path) throw conflict("the episode's video has not arrived");
  if (!asset.transcript_id) ctx.queue.enqueue("transcribe", `transcribe:${asset.id}`, { asset_id: asset.id }, { priority: PRIORITY.upNext });
}

/**
 * Job body: the episode's video. A feed's own file is downloaded and stored here, like audio, then transcribed. A
 * YouTube video has nothing to download here: the job parks until the home fetcher has brought it, then finishes.
 */
export async function fetchVideoJob(ctx: AppContext, job: Job<{ episode_id: string }>): Promise<AudioAssetRow> {
  const ep = getEpisodeRow(ctx, job.payload.episode_id);
  const current = ep.current_asset_id ? getAssetRow(ctx, ep.current_asset_id) : null;
  if (current?.video_path) return current;
  const url = ep.video_url_enc ? ctx.secrets.decrypt(ep.video_url_enc) : ep.media_kind === "video" && !ep.youtube_id ? ctx.secrets.decrypt(ep.enclosure_url_enc) : null;
  if (!url) throw new DeferJob("waiting for the home fetcher");
  await mkdir(ctx.paths.tmp, { recursive: true });
  const tmp = join(ctx.paths.tmp, `${newId()}.video`);
  try {
    const res = await safeFetch(url, { timeoutMs: 120_000, headers: { accept: "video/*,*/*" }, allowPrivateNetwork: ctx.config.allowPrivateNetwork });
    if (res.status !== 200) {
      await res.body?.cancel();
      if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 410) throw new NonRetryable(`video returned ${res.status}`);
      throw new Error(`video returned ${res.status}`);
    }
    await downloadToFile(res, tmp);
    const asset = await storeVideoFile(ctx, ep.id, tmp);
    ctx.log("video fetched", { episode_id: ep.id, url: redact(url) });
    if (!asset.transcript_id) ctx.queue.enqueue("transcribe", `transcribe:${asset.id}`, { asset_id: asset.id }, { priority: Math.max(PRIORITY.catalog, job.priority) });
    return asset;
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
