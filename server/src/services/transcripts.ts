import { queueSpeakers } from "./speakers.js";
import type { AppContext } from "../app/context.js";
import { notFound } from "../app/errors.js";
import { wordRangeByMidpoint } from "../core/snip/select.js";
import { normalize, sliceWords } from "../core/transcript/normalize.js";
import { toApiTranscript, type ApiTranscript, type NormalizedTranscript, type Segment } from "../core/transcript/types.js";
import type { AudioAssetRow, EpisodeRow, FeedRow, SegmentRow, TranscriptRow } from "../db/rows.js";
import { PRIORITY, type Job } from "../jobs/queue.js";
import { newId } from "../lib/ids.js";
import { getAssetRow } from "./episodes.js";
import { applyTextPolicyForAsset } from "./textPolicy.js";
import { queueAdDetection } from "./adBreaks.js";
import { DeferJob } from "../jobs/errors.js";

export function getTranscriptRow(ctx: AppContext, id: string): TranscriptRow {
  const row = ctx.db.prepare("SELECT * FROM transcript WHERE id = ?").get(id) as TranscriptRow | undefined;
  if (!row) throw notFound("transcript");
  return row;
}

/** Rebuild the normalized transcript from its stored segments. */
export function loadTranscript(ctx: AppContext, id: string): NormalizedTranscript {
  const row = getTranscriptRow(ctx, id);
  const segments = (ctx.db.prepare("SELECT * FROM transcript_segment WHERE transcript_id = ? ORDER BY idx").all(id) as SegmentRow[]).map(
    (s): Segment => ({ idx: s.idx, start_ms: s.start_ms, end_ms: s.end_ms, speaker: s.speaker, first_word: s.first_word, text: s.text, words: JSON.parse(s.words) }),
  );
  return { provider: row.provider, model: row.model, language: row.language, word_count: row.word_count, segments, events: JSON.parse(row.events) };
}

export function transcriptForAsset(ctx: AppContext, asset: AudioAssetRow): NormalizedTranscript | null {
  return asset.transcript_id ? loadTranscript(ctx, asset.transcript_id) : null;
}

export function transcriptApi(ctx: AppContext, id: string): ApiTranscript {
  const row = getTranscriptRow(ctx, id);
  return toApiTranscript(loadTranscript(ctx, id), { id: row.id, asset_id: row.audio_asset_id });
}

/**
 * Persist a normalized transcript as the asset's current one, wake snips that were waiting for it,
 * and queue the episode summary.
 */
export type StoreTranscriptMeta = {
  cost_cents?: number | undefined;
  provider_request_id?: string | undefined;
  /** 'asr' (default), the publisher text source the words came from ('email', 'rss'), or a video's own 'captions'. */
  source?: "asr" | "email" | "rss" | "captions";
  text_id?: string;
  loss?: number;
  /** Make this the asset's current transcript (default true). False stores it alongside for comparison. */
  make_current?: boolean;
};

export function storeTranscript(ctx: AppContext, assetId: string, t: NormalizedTranscript, meta: StoreTranscriptMeta): TranscriptRow {
  const id = newId();
  const now = ctx.now();
  const makeCurrent = meta.make_current !== false;
  ctx.db.transaction(() => {
    ctx.db
      .prepare("INSERT INTO transcript (id, audio_asset_id, provider, model, language, word_count, events, cost_cents, provider_request_id, source, text_id, loss, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, assetId, t.provider, t.model, t.language, t.word_count, JSON.stringify(t.events), meta.cost_cents ?? null, meta.provider_request_id ?? null, meta.source ?? "asr", meta.text_id ?? null, meta.loss ?? null, now);
    const insert = ctx.db.prepare("INSERT INTO transcript_segment (transcript_id, idx, start_ms, end_ms, speaker, first_word, text, words) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const s of t.segments) insert.run(id, s.idx, s.start_ms, s.end_ms, s.speaker, s.first_word, s.text, JSON.stringify(s.words));
    if (makeCurrent) ctx.db.prepare("UPDATE audio_asset SET transcript_id = ? WHERE id = ?").run(id, assetId);
  })();
  // Either kind of transcript changes what ad detection sees: ASR holds the ads, publisher text shows where they are.
  queueAdDetection(ctx, assetId);
  if (!makeCurrent) return getTranscriptRow(ctx, id);

  const waiting = ctx.db
    .prepare("SELECT r.id FROM snip_revision r JOIN snip s ON s.id = r.snip_id WHERE s.audio_asset_id = ? AND s.current_revision_id = r.id AND r.status = 'waiting'")
    .pluck()
    .all(assetId) as string[];
  for (const revisionId of waiting) {
    if (!ctx.queue.wake(`select_snip:${revisionId}`)) ctx.queue.enqueue("select_snip", `select_snip:${revisionId}`, { revision_id: revisionId }, { priority: PRIORITY.snip });
  }
  attachWordsToEditedRevisions(ctx, assetId, id, t);
  ctx.queue.enqueue("summarize_episode", `summarize_episode:${assetId}`, { asset_id: assetId }, { priority: PRIORITY.catalog });
  queueSpeakers(ctx, id);
  return getTranscriptRow(ctx, id);
}

/**
 * A span the owner edited before the recording had a transcript has no words, so its summary was skipped. Once a
 * transcript exists, give such revisions their word range and excerpt from their milliseconds and summarize them.
 * The span itself never moves: the owner chose it.
 */
function attachWordsToEditedRevisions(ctx: AppContext, assetId: string, transcriptId: string, t: NormalizedTranscript): void {
  const revisions = ctx.db
    .prepare(
      `SELECT r.id, r.start_ms, r.end_ms FROM snip_revision r JOIN snip s ON s.id = r.snip_id
       WHERE s.audio_asset_id = ? AND s.current_revision_id = r.id AND s.deleted_at IS NULL
         AND r.start_word IS NULL AND r.summary_status = 'skipped' AND r.status IN ('preparing', 'ready')`,
    )
    .all(assetId) as { id: string; start_ms: number; end_ms: number }[];
  for (const r of revisions) {
    const range = wordRangeByMidpoint(t, r.start_ms, r.end_ms);
    if (!range) continue;
    const excerpt = sliceWords(t, range.start_word, range.end_word).map((w) => w[2]).join(" ");
    ctx.db
      .prepare("UPDATE snip_revision SET transcript_id = ?, start_word = ?, end_word = ?, excerpt = ?, summary_status = 'pending' WHERE id = ?")
      .run(transcriptId, range.start_word, range.end_word, excerpt, r.id);
    // The summary job for this revision already ran (and skipped), so it has to be queued again explicitly.
    ctx.queue.enqueue("summarize_snip", `summarize_snip:${r.id}`, { revision_id: r.id }, { priority: PRIORITY.snip, rerun: true });
  }
}

/** Minutes of audio transcribed since the first of the current UTC month, for the catalog budget. */
export function minutesTranscribedThisMonth(ctx: AppContext): number {
  const d = new Date(ctx.now());
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const row = ctx.db
    .prepare("SELECT COALESCE(SUM(a.duration_ms), 0) AS ms FROM transcript t JOIN audio_asset a ON a.id = t.audio_asset_id WHERE t.created_at >= ?")
    .get(monthStart) as { ms: number };
  return row.ms / 60_000;
}

/** Job body: transcribe an asset with the configured provider. Owner-triggered work ignores the monthly budget. */
export async function transcribeJob(ctx: AppContext, job: Job<{ asset_id: string }>): Promise<void> {
  const asset = getAssetRow(ctx, job.payload.asset_id);
  // Publisher text alone does not count: interviews need the speech as their transcript, and ad detection needs it for every kind.
  if (ctx.db.prepare("SELECT 1 FROM transcript WHERE audio_asset_id = ? AND source IN ('asr', 'captions') LIMIT 1").get(asset.id)) return;
  const moved = ctx.db.prepare("SELECT 1 FROM episode WHERE id = ? AND current_asset_id != ?").get(asset.episode_id, asset.id);
  const snipWaiting = ctx.db.prepare("SELECT 1 FROM snip_revision r JOIN snip s ON s.id = r.snip_id WHERE s.audio_asset_id = ? AND s.current_revision_id = r.id AND r.status = 'waiting' LIMIT 1").get(asset.id);
  if (moved && !snipWaiting) {
    ctx.log("transcription skipped", { asset_id: asset.id, reason: "the episode plays another recording now" });
    return;
  }
  if (!ctx.transcriber) throw new DeferJob("no transcriber configured (set ELEVENLABS_API_KEY)");
  if (job.priority <= PRIORITY.catalog) {
    const used = minutesTranscribedThisMonth(ctx);
    if (used + asset.duration_ms / 60_000 > ctx.config.transcriptionBudgetMinutes) {
      throw new DeferJob(`monthly transcription budget reached (${Math.round(used)} of ${ctx.config.transcriptionBudgetMinutes} minutes)`);
    }
  }
  const episode = ctx.db.prepare("SELECT * FROM episode WHERE id = ?").get(asset.episode_id) as EpisodeRow;
  const feed = ctx.db.prepare("SELECT * FROM feed WHERE id = ?").get(episode.feed_id) as FeedRow;
  const keyterms = JSON.parse(feed.keyterms) as string[];
  const language = languageCode(feed.language);
  const started = ctx.now();
  const raw = await ctx.transcriber.transcribe({
    path: asset.path,
    mime: asset.mime,
    duration_ms: asset.duration_ms,
    ...(language ? { language } : {}),
    ...(keyterms.length > 0 ? { keyterms } : {}),
  });
  const normalized = normalize(raw, { duration_ms: asset.duration_ms });
  const row = storeTranscript(ctx, asset.id, normalized, { cost_cents: raw.cost_cents, provider_request_id: raw.provider_request_id });
  applyTextPolicyForAsset(ctx, asset.id); // a preferred publisher-text transcript that landed first stays current
  ctx.log("transcript stored", { asset_id: asset.id, transcript_id: row.id, words: normalized.word_count, segments: normalized.segments.length, cost_cents: raw.cost_cents ?? null, elapsed_ms: ctx.now() - started });
}

/** `en-us` → `en`; passes ISO 639-1/639-3 through; null when unusable. */
export function languageCode(feedLanguage: string | null): string | null {
  if (!feedLanguage) return null;
  const base = feedLanguage.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return /^[a-z]{2,3}$/.test(base) ? base : null;
}
