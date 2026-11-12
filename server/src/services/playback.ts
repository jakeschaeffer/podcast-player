import type { AppContext } from "../app/context.js";
import { notFound } from "../app/errors.js";
import type { AudioAssetRow, PlaybackStateRow } from "../db/rows.js";
import { PRIORITY } from "../jobs/queue.js";
import { scheduleVideoPrune } from "./video.js";

export type PlaybackReport = { position_ms: number; speed: number; playing: boolean; finished: boolean; seq: number; observed_at?: number };
export type Resume = { position_ms: number; speed: number; finished: boolean; device_name: string; updated_at: number };

/** Two recordings of an episode this close in length are taken to be the same cut, so a place in one holds in the other. */
export const SAME_CUT_TOLERANCE_MS = 1000;

/**
 * Copy the place on one recording to another of the same cut, for one device or all of them. The newest observed place
 * wins, so a replayed report cannot move a device back. The copy keeps the seq, so the device's next report is accepted.
 * Returns whether anything changed; recordings of different lengths keep their own places.
 */
export function carryPlace(ctx: AppContext, fromAssetId: string, toAssetId: string, deviceId?: string): boolean {
  const lengths = ctx.db.prepare("SELECT id, duration_ms FROM audio_asset WHERE id IN (?, ?)").all(fromAssetId, toAssetId) as { id: string; duration_ms: number }[];
  const from = lengths.find((a) => a.id === fromAssetId);
  const to = lengths.find((a) => a.id === toAssetId);
  if (!from || !to || Math.abs(from.duration_ms - to.duration_ms) > SAME_CUT_TOLERANCE_MS) return false;
  const { changes } = ctx.db
    .prepare(
      `INSERT INTO playback_state (device_id, audio_asset_id, position_ms, speed, playing, finished, seq, updated_at, observed_at)
       SELECT device_id, ?, MIN(position_ms, ?), speed, 0, finished, seq, updated_at, observed_at FROM playback_state
       WHERE audio_asset_id = ? AND (? IS NULL OR device_id = ?)
       ON CONFLICT (device_id, audio_asset_id) DO UPDATE SET position_ms = excluded.position_ms, speed = excluded.speed, playing = 0, finished = excluded.finished, seq = MAX(seq, excluded.seq), updated_at = excluded.updated_at, observed_at = excluded.observed_at
       WHERE COALESCE(excluded.observed_at, excluded.updated_at) > COALESCE(observed_at, updated_at)`,
    )
    .run(toAssetId, to.duration_ms, fromAssetId, deviceId ?? null, deviceId ?? null);
  return changes > 0;
}

/**
 * Record a device's playback state. A `seq` not greater than the stored one is ignored, so offline replays
 * and reordered requests cannot move a device backwards. Starting playback on an untranscribed asset
 * raises transcription to play priority, and on a transcribed one without a summary, its summary.
 */
export function reportPlayback(ctx: AppContext, deviceId: string, assetId: string, report: PlaybackReport): { accepted: boolean; state: PlaybackStateRow } {
  const asset = ctx.db.prepare("SELECT * FROM audio_asset WHERE id = ?").get(assetId) as AudioAssetRow | undefined;
  if (!asset) throw notFound("audio asset");
  const position = Math.max(0, Math.min(asset.duration_ms, Math.round(report.position_ms)));
  const existing = ctx.db.prepare("SELECT * FROM playback_state WHERE device_id = ? AND audio_asset_id = ?").get(deviceId, assetId) as PlaybackStateRow | undefined;
  if (existing && report.seq <= existing.seq) return { accepted: false, state: existing };
  const now = ctx.now();
  // A device clock running fast must not make its reports win every cross-device comparison.
  const observedAt = report.observed_at !== undefined ? Math.min(Math.round(report.observed_at), now) : null;
  ctx.db
    .prepare(
      `INSERT INTO playback_state (device_id, audio_asset_id, position_ms, speed, playing, finished, seq, updated_at, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (device_id, audio_asset_id) DO UPDATE SET position_ms = excluded.position_ms, speed = excluded.speed, playing = excluded.playing, finished = excluded.finished, seq = excluded.seq, updated_at = excluded.updated_at, observed_at = excluded.observed_at`,
    )
    .run(deviceId, assetId, position, report.speed, report.playing ? 1 : 0, report.finished ? 1 : 0, report.seq, now, observedAt);
  if (report.finished) scheduleVideoPrune(ctx, asset.id);
  // A device can still be playing the recording the episode has moved on from; its place follows to the current one.
  const current = ctx.db.prepare("SELECT current_asset_id FROM episode WHERE id = ?").pluck().get(asset.episode_id) as string | null | undefined;
  if (current && current !== assetId && carryPlace(ctx, assetId, current, deviceId) && report.finished) scheduleVideoPrune(ctx, current);
  if (report.playing && asset.transcript_id === null) {
    // Shows in manual mode (auto_process off) are only transcribed on request or when a snip needs it.
    // Captions due another try will be the transcript for free, so playing does not bill for one meanwhile.
    const feed = ctx.db.prepare("SELECT f.auto_process, e.captions_retry_at FROM episode e JOIN feed f ON f.id = e.feed_id WHERE e.id = ?").get(asset.episode_id) as { auto_process: number; captions_retry_at: number | null } | undefined;
    if (feed?.auto_process === 1 && feed.captions_retry_at === null) ctx.queue.enqueue("transcribe", `transcribe:${assetId}`, { asset_id: assetId }, { priority: PRIORITY.play });
  }
  if (report.playing && asset.transcript_id !== null && asset.summary_id === null) requestSummaryForPlay(ctx, assetId);
  const state = ctx.db.prepare("SELECT * FROM playback_state WHERE device_id = ? AND audio_asset_id = ?").get(deviceId, assetId) as PlaybackStateRow;
  return { accepted: true, state };
}

/**
 * Playing a transcribed recording that has no summary queues one at play priority, in the background: the report
 * only writes a job row. A summary job never queued, or one parked while no text model was configured, runs now. A
 * failed one is left alone (a rejected summary would cost a Codex call on every report); the owner's Process retries it.
 */
function requestSummaryForPlay(ctx: AppContext, assetId: string): void {
  if (!ctx.textModel) return; // the job would only park itself again
  const key = `summarize_episode:${assetId}`;
  const status = ctx.queue.byKey(key)?.status;
  if (status === "failed" || status === "done") return;
  ctx.queue.enqueue("summarize_episode", key, { asset_id: assetId }, { priority: PRIORITY.play });
}

/**
 * Most recent state across devices, by when each position was observed: a report replayed after a flight is
 * placed at the time it happened, not when it arrived. A deliberate rewind wins over an older further position.
 */
export function resumeFor(ctx: AppContext, assetId: string): Resume | null {
  const row = ctx.db
    .prepare(
      `SELECT p.*, d.name AS device_name, COALESCE(p.observed_at, p.updated_at) AS at FROM playback_state p JOIN device d ON d.id = p.device_id
       WHERE p.audio_asset_id = ? ORDER BY at DESC LIMIT 1`,
    )
    .get(assetId) as (PlaybackStateRow & { device_name: string; at: number }) | undefined;
  if (!row) return null;
  return { position_ms: row.position_ms, speed: row.speed, finished: row.finished === 1, device_name: row.device_name, updated_at: row.at };
}
