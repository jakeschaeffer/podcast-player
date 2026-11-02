import { mkdir, rename, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import type { AppContext } from "../app/context.js";
import { notFound } from "../app/errors.js";
import type { AudioAssetRow, EpisodeRow, EpisodeSummaryRow, FeedRow } from "../db/rows.js";
import { PRIORITY, type Job } from "../jobs/queue.js";
import { probeAudio } from "../lib/ffprobe.js";
import { newId } from "../lib/ids.js";
import { downloadToFile, redact, safeFetch } from "../lib/safeFetch.js";
import { NonRetryable } from "../jobs/errors.js";
import { hashFile } from "../lib/hash.js";
import { fetchVideoJob, fromHomeFetcher, requestVideo, storeVideoFile, videoView, type VideoView } from "./video.js";
import { signMediaUrl } from "./media.js";
import { resumeFor } from "./playback.js";
import { adBreaksFor } from "./adBreaks.js";
import { fetchFeedChapters, publishedChapters } from "./chapters.js";
import type { AdBreak } from "../core/ads/detect.js";

export type ProcessingState = "none" | "queued" | "running" | "deferred" | "failed" | "ready";

export type EpisodeListItem = {
  id: string;
  feed_id: string;
  show_title: string | null;
  title: string;
  published_at: number | null;
  duration_ms: number | null;
  image_url: string | null;
  asset_id: string | null;
  transcript_id: string | null;
  has_summary: boolean;
  processing: { audio: ProcessingState; transcript: ProcessingState; text: ProcessingState; summary: ProcessingState };
  resume: { position_ms: number; speed: number; finished: boolean; device_name: string; updated_at: number } | null;
  /** 'video' when the episode is a video; the YouTube video it is or links; where its video stands (docs/video-plan.md). */
  media_kind: "audio" | "video";
  youtube_id: string | null;
  video: VideoView;
};

export type EpisodeTextSummary = { id: string; source: string; kind: string | null; word_count: number; sections: { title: string; start_ms: number | null; start_word: number | null }[]; aligned_transcript_id: string | null };

export type ChapterItem = { start_ms: number; end_ms: number; start_word: number | null; end_word: number | null; title: string; description: string | null; kind: string };
/** `publisher`: aligned publisher text's sections; `feed`: the feed's chapters; `shownotes`: timestamps in the show notes; `ai`: the summary's. */
export type EpisodeChapters = { source: "publisher" | "feed" | "shownotes" | "ai"; transcript_id: string | null; items: ChapterItem[] } | null;

export type EpisodeDetail = EpisodeListItem & {
  description_html: string | null;
  link: string | null;
  /** Publisher text for this episode (from a text feed or email), with section start times once aligned. */
  text: EpisodeTextSummary | null;
  /**
   * Chapters to seek by, the publisher's whenever it gave any: aligned text sections, else the feed's chapters, else
   * show-notes timestamps, else the model's, else null. Word indices refer to `transcript_id` (null before a transcript).
   */
  chapters: EpisodeChapters;
  asset: { id: string; duration_ms: number; mime: string; bytes: number; audio_url: string; video_url: string | null; video_width: number | null; video_height: number | null; video_bytes: number | null } | null;
  summary: { id: string; preview: string; takeaways: { text: string; word: number }[]; chapters: unknown[]; model: string; prompt_version: string } | null;
  snip_count: number;
  /** Suspected ad breaks in milliseconds on `asset`, for a "Skip ad" button; empty until detection has run. */
  ad_breaks: AdBreak[];
};

export function getEpisodeRow(ctx: AppContext, id: string): EpisodeRow {
  const row = ctx.db.prepare("SELECT * FROM episode WHERE id = ?").get(id) as EpisodeRow | undefined;
  if (!row) throw notFound("episode");
  return row;
}

export function getAssetRow(ctx: AppContext, id: string): AudioAssetRow {
  const row = ctx.db.prepare("SELECT * FROM audio_asset WHERE id = ?").get(id) as AudioAssetRow | undefined;
  if (!row) throw notFound("audio asset");
  return row;
}

function jobState(ctx: AppContext, key: string, readyWhen: boolean): ProcessingState {
  if (readyWhen) return "ready";
  const job = ctx.queue.byKey(key);
  if (!job) return "none";
  if (job.status === "done") return "ready";
  return job.status;
}

/** Publisher text: none known, or the alignment job's state, or ready once an aligned transcript exists. */
function textState(ctx: AppContext, episodeId: string, asset: AudioAssetRow | null): ProcessingState {
  const text = ctx.db.prepare("SELECT id FROM episode_text WHERE episode_id = ? ORDER BY created_at DESC LIMIT 1").get(episodeId) as { id: string } | undefined;
  if (!text) return "none";
  if (!asset) return "queued";
  const aligned = ctx.db.prepare("SELECT 1 FROM transcript WHERE audio_asset_id = ? AND source != 'asr'").get(asset.id);
  return jobState(ctx, `align_text:${text.id}`, aligned !== undefined);
}

/**
 * Run the whole pipeline for one episode at owner priority, regardless of the feed's auto_process setting:
 * fetch audio if missing, transcribe, align any publisher text, and summarize. Idempotent; returns the detail.
 */
export function processEpisode(ctx: AppContext, episodeId: string, deviceId: string): EpisodeDetail {
  requestPipeline(ctx, getEpisodeRow(ctx, episodeId), PRIORITY.play);
  return getEpisode(ctx, episodeId, deviceId);
}

/** The owner asked for this episode (Transcribe, or adding it to Up next): queue every step it still lacks. */
function requestPipeline(ctx: AppContext, ep: EpisodeRow, priority: number): void {
  if (!ep.current_asset_id) {
    if (fromHomeFetcher(ep)) requestVideo(ctx, ep.id, priority);
    else ctx.queue.enqueue("fetch_audio", `fetch_audio:${ep.id}`, { episode_id: ep.id, then: "transcribe" }, { priority });
    return;
  }
  const assetId = ep.current_asset_id;
  const hasAsr = ctx.db.prepare("SELECT 1 FROM transcript WHERE audio_asset_id = ? AND source IN ('asr', 'captions')").get(assetId);
  if (!hasAsr) ctx.queue.enqueue("transcribe", `transcribe:${assetId}`, { asset_id: assetId }, { priority });
  const texts = ctx.db.prepare("SELECT id FROM episode_text WHERE episode_id = ?").pluck().all(ep.id) as string[];
  for (const textId of texts) ctx.queue.enqueue("align_text", `align_text:${textId}`, { text_id: textId }, { priority });
  const asset = getAssetRow(ctx, assetId);
  if (asset.transcript_id && !asset.summary_id) ctx.queue.enqueue("summarize_episode", `summarize_episode:${assetId}`, { asset_id: assetId }, { priority });
}

function toListItem(ctx: AppContext, ep: EpisodeRow, feed: Pick<FeedRow, "title">, asset: AudioAssetRow | null): EpisodeListItem {
  return {
    id: ep.id,
    feed_id: ep.feed_id,
    show_title: feed.title,
    title: ep.title,
    published_at: ep.published_at,
    duration_ms: asset?.duration_ms ?? ep.duration_hint_ms,
    image_url: ep.image_url,
    asset_id: asset?.id ?? null,
    transcript_id: asset?.transcript_id ?? null,
    has_summary: asset?.summary_id !== null && asset?.summary_id !== undefined,
    processing: {
      audio: jobState(ctx, `fetch_audio:${ep.id}`, asset !== null),
      transcript: asset ? jobState(ctx, `transcribe:${asset.id}`, (ctx.db.prepare("SELECT 1 FROM transcript WHERE audio_asset_id = ? AND source IN ('asr', 'captions')").get(asset.id) ?? null) !== null) : "none",
      text: textState(ctx, ep.id, asset),
      summary: asset ? jobState(ctx, `summarize_episode:${asset.id}`, asset.summary_id !== null) : "none",
    },
    resume: asset ? resumeFor(ctx, asset.id) : null,
    media_kind: ep.media_kind,
    youtube_id: ep.youtube_id,
    video: videoView(ctx, ep, asset),
  };
}

export function listEpisodes(ctx: AppContext, opts: { feed_id?: string; after?: string; limit?: number } = {}): { items: EpisodeListItem[]; next: string | null } {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.feed_id) { where.push("e.feed_id = ?"); args.push(opts.feed_id); }
  // Across feeds (Today), an unfollowed show's episodes appear only while one is in progress, for Continue listening.
  else where.push("(f.followed = 1 OR EXISTS (SELECT 1 FROM playback_state p WHERE p.audio_asset_id = e.current_asset_id AND p.finished = 0 AND p.position_ms > 0))");
  if (opts.after) {
    const [pub, id] = opts.after.split("_");
    where.push("(COALESCE(e.published_at, 0) < ? OR (COALESCE(e.published_at, 0) = ? AND e.id < ?))");
    args.push(Number(pub), Number(pub), id);
  }
  const rows = ctx.db
    .prepare(`SELECT e.*, f.title AS feed_title FROM episode e JOIN feed f ON f.id = e.feed_id ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY COALESCE(e.published_at, 0) DESC, e.id DESC LIMIT ?`)
    .all(...args, limit + 1) as (EpisodeRow & { feed_title: string | null })[];
  const page = rows.slice(0, limit);
  const items = page.map((r) => toListItem(ctx, r, { title: r.feed_title }, r.current_asset_id ? getAssetRow(ctx, r.current_asset_id) : null));
  const last = page[page.length - 1];
  return { items, next: rows.length > limit && last ? `${last.published_at ?? 0}_${last.id}` : null };
}

/**
 * Up next: every episode started and not finished, and every one the owner added, in the owner's order. Episodes
 * without a place (heard partway and never moved, or listened to since they were placed) come first, the one listened
 * to most recently first, so leaving one episode for another puts the one left at the top; then the placed ones in the
 * owner's order. As with `resume`, an episode's latest report from any device decides. Clients leave out the episode
 * that is playing. Removing one takes it out until it is played again or added back.
 */
export function listQueue(ctx: AppContext, opts: { limit?: number } = {}): { items: EpisodeListItem[] } {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const rows = ctx.db
    .prepare(
      `WITH latest AS (
         SELECT audio_asset_id, position_ms, finished, COALESCE(observed_at, updated_at) AS at,
                ROW_NUMBER() OVER (PARTITION BY audio_asset_id ORDER BY COALESCE(observed_at, updated_at) DESC) AS rn
         FROM playback_state)
       SELECT e.*, f.title AS feed_title, l.at AS heard_at, l.finished AS heard_finished, l.position_ms AS heard_position,
              u.position, u.placed_at, u.added_at, u.hidden_at
       FROM episode e
       JOIN feed f ON f.id = e.feed_id
       LEFT JOIN latest l ON l.audio_asset_id = e.current_asset_id AND l.rn = 1
       LEFT JOIN up_next u ON u.episode_id = e.id
       WHERE (l.finished = 0 AND l.position_ms > 0) OR u.added_at IS NOT NULL`,
    )
    .all() as QueueRow[];
  const items = rows
    .filter(inQueue)
    .map((r) => ({ r, heard: r.heard_at ?? 0, placed: r.position !== null && r.placed_at !== null && r.placed_at >= (r.heard_at ?? 0) }))
    .sort((a, b) => {
      if (a.placed !== b.placed) return a.placed ? 1 : -1;
      if (a.placed) return a.r.position! - b.r.position! || (a.r.id < b.r.id ? -1 : 1);
      const recency = (x: typeof a) => Math.max(x.heard, x.r.added_at ?? 0);
      return recency(b) - recency(a) || (a.r.id < b.r.id ? 1 : -1);
    })
    .slice(0, limit);
  return { items: items.map(({ r }) => toListItem(ctx, r, { title: r.feed_title }, r.current_asset_id ? getAssetRow(ctx, r.current_asset_id) : null)) };
}

type QueueRow = EpisodeRow & {
  feed_title: string | null; heard_at: number | null; heard_finished: number | null; heard_position: number | null;
  position: number | null; placed_at: number | null; added_at: number | null; hidden_at: number | null;
};

/** Heard partway, or added (and not finished since), and not removed since either. */
function inQueue(r: QueueRow): boolean {
  const heard = r.heard_at ?? 0;
  const halfHeard = r.heard_finished === 0 && (r.heard_position ?? 0) > 0;
  const added = r.added_at !== null && (r.heard_at === null || r.heard_finished === 0 || r.added_at > heard);
  const removed = r.hidden_at !== null && r.hidden_at >= heard && r.hidden_at >= (r.added_at ?? 0);
  return (halfHeard || added) && !removed;
}

/** The owner's order for these episodes, first to last; episodes left out keep their places. */
export function setQueueOrder(ctx: AppContext, episodeIds: string[]): { items: EpisodeListItem[] } {
  const now = ctx.now();
  const place = ctx.db.prepare(
    `INSERT INTO up_next (episode_id, position, placed_at) VALUES (?, ?, ?)
     ON CONFLICT (episode_id) DO UPDATE SET position = excluded.position, placed_at = excluded.placed_at`,
  );
  ctx.db.transaction(() => {
    episodeIds.forEach((id, i) => {
      getEpisodeRow(ctx, id);
      place.run(id, i, now);
    });
  })();
  return listQueue(ctx, { limit: 200 });
}

/**
 * Add an episode to the end of Up next (again, if it was finished or removed). Adding is asking for it, like the
 * Transcribe button: its recording is fetched and transcribed (and summarized) now, whatever the show's
 * auto_process, so that when the episode before it ends it can start at once with its transcript, and a phone that
 * has stopped playing is not left waiting on a download. Owner priority, so the monthly budget does not hold it back.
 */
export function addToQueue(ctx: AppContext, episodeId: string): { items: EpisodeListItem[] } {
  requestPipeline(ctx, getEpisodeRow(ctx, episodeId), PRIORITY.upNext);
  const now = ctx.now();
  const last = (ctx.db.prepare("SELECT MAX(position) AS p FROM up_next WHERE episode_id != ?").get(episodeId) as { p: number | null }).p;
  ctx.db
    .prepare(
      `INSERT INTO up_next (episode_id, position, placed_at, added_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (episode_id) DO UPDATE SET position = excluded.position, placed_at = excluded.placed_at, added_at = excluded.added_at, hidden_at = NULL`,
    )
    .run(episodeId, (last ?? -1) + 1, now, now);
  return listQueue(ctx, { limit: 200 });
}

/** Take an episode out of Up next without marking it played; listening to it again or adding it brings it back. */
export function removeFromQueue(ctx: AppContext, episodeId: string): { items: EpisodeListItem[] } {
  getEpisodeRow(ctx, episodeId);
  ctx.db
    .prepare(
      `INSERT INTO up_next (episode_id, hidden_at) VALUES (?, ?)
       ON CONFLICT (episode_id) DO UPDATE SET hidden_at = excluded.hidden_at, position = NULL, placed_at = NULL, added_at = NULL`,
    )
    .run(episodeId, ctx.now());
  return listQueue(ctx, { limit: 200 });
}

export function getEpisode(ctx: AppContext, id: string, deviceId: string): EpisodeDetail {
  const ep = getEpisodeRow(ctx, id);
  const feed = ctx.db.prepare("SELECT * FROM feed WHERE id = ?").get(ep.feed_id) as FeedRow;
  const asset = ep.current_asset_id ? getAssetRow(ctx, ep.current_asset_id) : null;
  const item = toListItem(ctx, ep, feed, asset);
  const summaryRow = asset?.summary_id ? (ctx.db.prepare("SELECT * FROM episode_summary WHERE id = ?").get(asset.summary_id) as EpisodeSummaryRow | undefined) : undefined;
  // Every snip of the episode, from its audio and its video alike.
  const snipCount = (ctx.db.prepare("SELECT COUNT(*) AS n FROM snip s JOIN audio_asset a ON a.id = s.audio_asset_id WHERE a.episode_id = ? AND s.deleted_at IS NULL").get(ep.id) as { n: number }).n;
  const { textRow, alignedId } = publisherTextFor(ctx, ep, asset);
  const chapters = chaptersFor(ctx, ep, asset, textRow, alignedId, summaryRow);
  return {
    ...item,
    description_html: ep.description_html,
    link: ep.link,
    chapters,
    text: textRow
      ? { id: textRow.id, source: textRow.source, kind: textRow.kind, word_count: textRow.word_count, sections: (JSON.parse(textRow.sections) as SectionJson[]).map((x) => ({ title: x.title, start_ms: x.start_ms ?? null, start_word: x.start_word ?? null })), aligned_transcript_id: alignedId }
      : null,
    asset: asset
      ? {
          id: asset.id, duration_ms: asset.duration_ms, mime: asset.mime, bytes: asset.bytes, audio_url: signMediaUrl(ctx, "asset", asset.id, deviceId),
          video_url: asset.video_path ? signMediaUrl(ctx, "video", asset.id, deviceId) : null,
          video_width: asset.video_width, video_height: asset.video_height, video_bytes: asset.video_path ? asset.video_bytes : null,
        }
      : null,
    summary: summaryRow
      ? { id: summaryRow.id, preview: summaryRow.preview, takeaways: JSON.parse(summaryRow.takeaways), chapters: JSON.parse(summaryRow.chapters), model: summaryRow.model, prompt_version: summaryRow.prompt_version }
      : null,
    snip_count: snipCount,
    ad_breaks: asset ? adBreaksFor(ctx, asset) : [],
  };
}

/** The publisher text to show for an episode: the row the aligned transcript came from, else the newest. */
function publisherTextFor(ctx: AppContext, ep: EpisodeRow, asset: AudioAssetRow | null): { textRow: TextRowSummary | undefined; alignedId: string | null } {
  const alignedRow = asset ? (ctx.db.prepare("SELECT id, text_id FROM transcript WHERE audio_asset_id = ? AND source != 'asr' ORDER BY created_at DESC LIMIT 1").get(asset.id) as { id: string; text_id: string | null } | undefined) : undefined;
  const byId = alignedRow?.text_id ? (ctx.db.prepare("SELECT id, source, kind, word_count, sections FROM episode_text WHERE id = ?").get(alignedRow.text_id) as TextRowSummary | undefined) : undefined;
  const newest = ctx.db.prepare("SELECT id, source, kind, word_count, sections FROM episode_text WHERE episode_id = ? ORDER BY created_at DESC LIMIT 1").get(ep.id) as TextRowSummary | undefined;
  return { textRow: byId ?? newest, alignedId: alignedRow?.id ?? null };
}

type TextRowSummary = { id: string; source: string; kind: string | null; word_count: number; sections: string };
type SectionJson = { title: string; start_ms?: number | null; start_word?: number | null };

/**
 * Chapters the publisher wrote come before chapters the model inferred: aligned publisher text's sections, then the
 * feed's chapters, then show-notes timestamps (services/chapters.ts), and only then the summary's.
 */
function chaptersFor(ctx: AppContext, ep: EpisodeRow, asset: AudioAssetRow | null, textRow: TextRowSummary | undefined, alignedId: string | null, summaryRow: EpisodeSummaryRow | undefined): EpisodeChapters {
  if (textRow && asset && alignedId) {
    const sections = (JSON.parse(textRow.sections) as SectionJson[]).filter((x) => x.start_ms !== null && x.start_ms !== undefined);
    if (sections.length > 0) {
      const wordCount = (ctx.db.prepare("SELECT word_count FROM transcript WHERE id = ?").get(alignedId) as { word_count: number }).word_count;
      const items = sections.map((x, i) => ({
        start_ms: i === 0 ? 0 : x.start_ms!,
        end_ms: sections[i + 1]?.start_ms ?? asset.duration_ms,
        start_word: i === 0 ? 0 : x.start_word ?? null,
        end_word: sections[i + 1]?.start_word ?? wordCount,
        title: x.title,
        description: null,
        kind: "content",
      }));
      return { source: "publisher", transcript_id: alignedId, items };
    }
  }
  const published = publishedChapters(ctx, ep, asset);
  if (published) return published;
  if (summaryRow) {
    return { source: "ai", transcript_id: summaryRow.transcript_id, items: (JSON.parse(summaryRow.chapters) as ChapterItem[]).map((c) => ({ ...c, description: c.description ?? null })) };
  }
  return null;
}

/**
 * The player's request for a recording it is about to play. A show in manual mode (auto_process off) is only
 * transcribed on request or when a snip needs it, so its recording is fetched without queuing transcription;
 * starting playback on an automatic show transcribes it, as reportPlayback does once the recording exists.
 */
export function ensureAudioForPlay(ctx: AppContext, episodeId: string): void {
  const feed = ctx.db.prepare("SELECT f.auto_process FROM episode e JOIN feed f ON f.id = e.feed_id WHERE e.id = ?").get(episodeId) as { auto_process: number } | undefined;
  ensureAudio(ctx, episodeId, PRIORITY.play, feed?.auto_process === 1 ? "transcribe" : "none");
}

/** Make sure the episode's recording is on its way; returns the asset when it already exists. */
export function ensureAudio(ctx: AppContext, episodeId: string, priority: number, then: "transcribe" | "none" = "transcribe"): { asset: AudioAssetRow | null; job_id: string | null } {
  const ep = getEpisodeRow(ctx, episodeId);
  if (ep.current_asset_id) return { asset: getAssetRow(ctx, ep.current_asset_id), job_id: null };
  if (fromHomeFetcher(ep)) {
    requestVideo(ctx, ep.id, priority);
    return { asset: null, job_id: null };
  }
  const { id } = ctx.queue.enqueue("fetch_audio", `fetch_audio:${episodeId}`, { episode_id: episodeId, then }, { priority });
  return { asset: null, job_id: id };
}

/**
 * Job body: download the enclosure to a temp file, validate it with ffprobe, hash it, and move it into the
 * content-addressed store. A failed or truncated download leaves no asset behind.
 */
export async function fetchAudioJob(ctx: AppContext, job: Job<{ episode_id: string; then?: "transcribe" | "none" }>): Promise<AudioAssetRow> {
  const ep = getEpisodeRow(ctx, job.payload.episode_id);
  if (ep.current_asset_id) return getAssetRow(ctx, ep.current_asset_id);
  // A channel's video is the video job's business; one queued here anyway (an older build) just follows it.
  if (fromHomeFetcher(ep)) return fetchVideoJob(ctx, job);
  const url = ctx.secrets.decrypt(ep.enclosure_url_enc);
  await mkdir(ctx.paths.tmp, { recursive: true });
  const tmp = join(ctx.paths.tmp, `${newId()}.download`);
  try {
    const res = await safeFetch(url, { timeoutMs: 120_000, headers: { accept: "audio/*,*/*" }, allowPrivateNetwork: ctx.config.allowPrivateNetwork });
    if (res.status !== 200) {
      await res.body?.cancel();
      if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 410) throw new NonRetryable(`enclosure returned ${res.status}`);
      throw new Error(`enclosure returned ${res.status}`);
    }
    const declared = Number(res.headers.get("content-length"));
    const bytes = await downloadToFile(res, tmp);
    if (Number.isFinite(declared) && declared > 0 && declared !== bytes) throw new Error(`download truncated: ${bytes} of ${declared} bytes`);
    const probe = await probeAudio(tmp);
    // A feed whose only enclosure is a video: keep it as the episode's video, with its audio pulled out beside it.
    if (probe.video) {
      const asset = await storeVideoFile(ctx, ep.id, tmp);
      if ((job.payload.then ?? "transcribe") === "transcribe") ctx.queue.enqueue("transcribe", `transcribe:${asset.id}`, { asset_id: asset.id }, { priority: Math.max(PRIORITY.catalog, job.priority) });
      return asset;
    }
    const sha256 = await hashFile(tmp);
    const ext = extensionFor(probe.mime, url);
    // Content-addressed: identical bytes land on one file, but every episode gets its own asset row.
    const finalPath = join(ctx.paths.assets, `${sha256}${ext}`);
    await rename(tmp, finalPath);
    const asset: AudioAssetRow = {
      id: newId(), episode_id: ep.id, sha256, bytes, duration_ms: probe.duration_ms, mime: probe.mime, path: finalPath,
      transcript_id: null, summary_id: null, pinned: 0, created_at: ctx.now(),
      video_path: null, video_sha256: null, video_bytes: null, video_width: null, video_height: null, video_last_played_at: null,
    };
    ctx.db.transaction(() => {
      ctx.db
        .prepare("INSERT INTO audio_asset (id, episode_id, sha256, bytes, duration_ms, mime, path, pinned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)")
        .run(asset.id, asset.episode_id, asset.sha256, asset.bytes, asset.duration_ms, asset.mime, asset.path, asset.created_at);
      ctx.db.prepare("UPDATE episode SET current_asset_id = ? WHERE id = ? AND current_asset_id IS NULL").run(asset.id, ep.id);
    })();
    ctx.log("audio stored", { episode_id: ep.id, asset_id: asset.id, bytes, duration_ms: probe.duration_ms, url: redact(url) });
    if ((job.payload.then ?? "transcribe") === "transcribe") {
      ctx.queue.enqueue("transcribe", `transcribe:${asset.id}`, { asset_id: asset.id }, { priority: Math.max(PRIORITY.catalog, job.priority) });
    }
    // Publisher text that arrived before the audio can be aligned now.
    const texts = ctx.db.prepare("SELECT id FROM episode_text WHERE episode_id = ?").pluck().all(ep.id) as string[];
    for (const textId of texts) ctx.queue.enqueue("align_text", `align_text:${textId}`, { text_id: textId }, { priority: PRIORITY.catalog });
    // The feed's JSON chapters, if it names a file: fetched once the episode is worth the request (never throws).
    await fetchFeedChapters(ctx, ep.id);
    return asset;
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

function extensionFor(mime: string, url: string): string {
  if (mime === "audio/mpeg") return ".mp3";
  if (mime.startsWith("audio/mp4")) return ".m4a";
  if (mime.startsWith("audio/ogg")) return ".ogg";
  if (mime === "audio/wav") return ".wav";
  if (mime === "audio/flac") return ".flac";
  if (mime === "audio/aac") return ".aac";
  const fromUrl = extname(new URL(url).pathname).toLowerCase();
  return /^\.[a-z0-9]{2,5}$/.test(fromUrl) ? fromUrl : ".bin";
}

