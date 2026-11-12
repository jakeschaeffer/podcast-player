/**
 * The snip pipeline as jobs: select the span, render the clip, write the title and summary. Each body is
 * idempotent, checks that its revision is still current, and never promotes anything to the public page
 * except by marking the revision ready once the clip and the summary step both exist.
 */
import { speakerNames } from "./speakers.js";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import type { AppContext } from "../app/context.js";
import { posterPath, renderClip, renderVideoClip } from "../core/clip/render.js";
import { selectSpan, type Selection } from "../core/snip/select.js";
import { precedingSentences, sentencesForRange } from "../core/summary/input.js";
import { fallbackTitle, fallbackTitleFromText, summarizeSnip } from "../core/summary/snip.js";
import { fillGeneratedTitle } from "./titleEdits.js";
import { sliceWords } from "../core/transcript/normalize.js";
import type { AudioAssetRow, SnipRevisionRow, SnipRow } from "../db/rows.js";
import { DeferJob } from "../jobs/errors.js";
import { NonRetryable } from "../jobs/errors.js";
import { PRIORITY, type Job } from "../jobs/queue.js";
import { getAssetRow } from "./episodes.js";
import { applyOwnerEdit, enqueuePreparation, episodeForAsset, getRevisionRow } from "./snips.js";
import { queueReadwiseSync } from "./readwiseSync.js";
import { makeSpanPicker } from "./spanPicker.js";
import { loadTranscript, transcriptForAsset } from "./transcripts.js";

/** Job body: choose the span for a revision. Defers until the asset has a transcript. */
export async function selectSnipJob(ctx: AppContext, job: Job<{ revision_id: string }>): Promise<void> {
  const rev = getRevisionRow(ctx, job.payload.revision_id);
  const snip = ctx.db.prepare("SELECT * FROM snip WHERE id = ?").get(rev.snip_id) as SnipRow;
  if (snip.current_revision_id !== rev.id || snip.deleted_at !== null) return;
  if (rev.status !== "selecting" && rev.status !== "waiting") return;
  const asset = getAssetRow(ctx, snip.audio_asset_id);
  const transcript = transcriptForAsset(ctx, asset);
  if (!transcript) {
    ctx.db.prepare("UPDATE snip_revision SET status = 'waiting' WHERE id = ?").run(rev.id);
    ctx.queue.enqueue("transcribe", `transcribe:${asset.id}`, { asset_id: asset.id }, { priority: PRIORITY.snip });
    throw new DeferJob("waiting for transcript");
  }
  const picker = ctx.textModel && ctx.config.selectionModel ? makeSpanPicker(ctx.textModel) : undefined;
  const selection = await selectSpan({ transcript, anchor_ms: snip.anchor_ms, heard_from_ms: snip.heard_from_ms, duration_ms: asset.duration_ms, ...(picker ? { picker } : {}) });
  const excerpt = selection.start_word !== null && selection.end_word !== null ? sliceWords(transcript, selection.start_word, selection.end_word).map((w) => w[2]).join(" ") : null;
  ctx.db
    .prepare("UPDATE snip_revision SET method = ?, transcript_id = ?, start_ms = ?, end_ms = ?, start_word = ?, end_word = ?, excerpt = ?, status = 'preparing', selection = ? WHERE id = ?")
    .run(selection.method, asset.transcript_id, selection.start_ms, selection.end_ms, selection.start_word, selection.end_word, excerpt, JSON.stringify({ ...compactSelection(selection), ...(picker ? { picker_prompt_version: picker.prompt_version } : {}) }), rev.id);
  ctx.log("snip selected", { snip_id: snip.id, revision_id: rev.id, method: selection.method, start_ms: selection.start_ms, end_ms: selection.end_ms, model_rejection: selection.model_rejection });
  if (!applyOwnerEdit(ctx, snip.id, rev.id)) enqueuePreparation(ctx, rev.id);
}

/** What we keep of a selection for debugging and evals: enough to replay, without the full sentence list. */
function compactSelection(s: Selection) {
  return {
    version: s.version,
    window: s.window,
    method: s.method,
    chosen: s.chosen,
    eligible_end_ids: s.eligible_end_ids,
    candidates: s.candidates.slice(0, 5),
    model_rejection: s.model_rejection,
    sentences: s.sentences.filter((x) => x.eligible).map((x) => ({ id: x.id, start_word: x.start_word, end_word: x.end_word, start_ms: x.start_ms, end_ms: x.end_ms, speaker: x.speaker })),
  };
}

/** Job body: render the clip for a revision and mark it ready if the summary step has finished too. */
export async function renderClipJob(ctx: AppContext, job: Job<{ revision_id: string }>): Promise<void> {
  const rev = getRevisionRow(ctx, job.payload.revision_id);
  if (rev.clip_path) return markReadyIfComplete(ctx, rev.id);
  if (!isCurrent(ctx, rev)) return;
  const snip = ctx.db.prepare("SELECT * FROM snip WHERE id = ?").get(rev.snip_id) as SnipRow;
  const asset = getAssetRow(ctx, snip.audio_asset_id);
  const out = join(ctx.paths.clips, `${rev.id}.mp3`);
  const clip = await renderClip(asset.path, rev.start_ms, rev.end_ms, out);
  ctx.db.prepare("UPDATE snip_revision SET clip_path = ?, clip_sha256 = ?, clip_duration_ms = ? WHERE id = ?").run(clip.path, clip.sha256, clip.duration_ms, rev.id);
  markReadyIfComplete(ctx, rev.id);
}

/**
 * The video to cut a snip's picture from: the recording's own, or the one fetched again later, which is a new recording
 * with the same audio bytes and so the same timeline. Another video of the episode may run differently; it does not count.
 */
function videoSource(ctx: AppContext, asset: AudioAssetRow): string | null {
  if (asset.video_path) return asset.video_path;
  const same = ctx.db.prepare("SELECT video_path FROM audio_asset WHERE episode_id = ? AND sha256 = ? AND video_path IS NOT NULL LIMIT 1").get(asset.episode_id, asset.sha256) as { video_path: string } | undefined;
  return same?.video_path ?? null;
}

/**
 * Job body: the MP4 of a revision cut from a video, for its public page. Never holds up the revision: it is ready on its
 * MP3, and the page plays that until this exists. Without a video on disk there is nothing to do; the hourly sweep
 * below picks the revision up if one arrives.
 */
export async function renderVideoClipJob(ctx: AppContext, job: Job<{ revision_id: string }>): Promise<void> {
  const rev = getRevisionRow(ctx, job.payload.revision_id);
  if (rev.video_clip_path || !isCurrent(ctx, rev)) return;
  const snip = ctx.db.prepare("SELECT * FROM snip WHERE id = ?").get(rev.snip_id) as SnipRow;
  const source = videoSource(ctx, getAssetRow(ctx, snip.audio_asset_id));
  if (!source) return;
  const clip = await renderVideoClip(source, rev.start_ms, rev.end_ms, join(ctx.paths.clips, `${rev.id}.mp4`));
  ctx.db.prepare("UPDATE snip_revision SET video_clip_path = ?, video_clip_sha256 = ?, video_clip_width = ?, video_clip_height = ? WHERE id = ?").run(clip.path, clip.sha256, clip.width, clip.height, rev.id);
}

/**
 * Current revisions that could have a picture and do not: snips made before this existed, and ones whose video has come
 * back. A job that failed stays failed rather than retrying every hour; it is visible in the job list.
 */
export function queueMissingVideoClips(ctx: AppContext): number {
  const rows = ctx.db
    .prepare(
      `SELECT r.id FROM snip_revision r
         JOIN snip s ON s.current_revision_id = r.id AND s.deleted_at IS NULL
         JOIN audio_asset a ON a.id = s.audio_asset_id
         LEFT JOIN job j ON j.key = 'render_video_clip:' || r.id
        WHERE r.status = 'ready' AND r.video_clip_path IS NULL AND (j.id IS NULL OR j.status = 'done')
          AND EXISTS (SELECT 1 FROM audio_asset v WHERE v.episode_id = a.episode_id AND v.sha256 = a.sha256 AND v.video_path IS NOT NULL)`,
    )
    .all() as { id: string }[];
  for (const { id } of rows) ctx.queue.enqueue("render_video_clip", `render_video_clip:${id}`, { revision_id: id }, { priority: PRIORITY.snip, rerun: true });
  return rows.length;
}

/** Job body: title and summary for a revision's excerpt. Without a text model the excerpt publishes with a derived title. */
export async function summarizeSnipJob(ctx: AppContext, job: Job<{ revision_id: string }>): Promise<void> {
  const rev = getRevisionRow(ctx, job.payload.revision_id);
  if (rev.summary_status !== "pending") return markReadyIfComplete(ctx, rev.id);
  if (!isCurrent(ctx, rev)) return;
  const snip = ctx.db.prepare("SELECT * FROM snip WHERE id = ?").get(rev.snip_id) as SnipRow;
  const asset = getAssetRow(ctx, snip.audio_asset_id);
  // The revision's word range indexes the transcript it was cut from, which need not be the asset's current one.
  const transcript = rev.transcript_id ? loadTranscript(ctx, rev.transcript_id) : null;
  if (!transcript || rev.start_word === null || rev.end_word === null) {
    ctx.db.prepare("UPDATE snip_revision SET summary_status = 'skipped', title_source = COALESCE(title_source, 'fallback'), title = COALESCE(title, 'Snip') WHERE id = ?").run(rev.id);
    return markReadyIfComplete(ctx, rev.id);
  }
  const excerpt = sentencesForRange(transcript, rev.start_word, rev.end_word);
  if (!ctx.textModel) {
    // Replaces any earlier placeholder title (such as "Snip" from before a transcript existed), never the owner's.
    ctx.db
      .prepare(
        `UPDATE snip_revision SET summary_status = 'skipped', title = CASE WHEN title_source = 'owner' THEN title ELSE ? END,
           title_source = CASE WHEN title_source = 'owner' THEN 'owner' ELSE 'fallback' END WHERE id = ?`,
      )
      .run(fallbackTitle(excerpt), rev.id);
    return markReadyIfComplete(ctx, rev.id);
  }
  const { episode, feed } = episodeForAsset(ctx, asset.id);
  const preceding = precedingSentences(transcript, rev.start_word, 2);
  // Speakers the publisher names (the host, an interview's guest) may be named in the summary; others stay "the host".
  const speaker_names = rev.transcript_id ? speakerNames(ctx, rev.transcript_id) : {};
  const result = await summarizeSnip({ excerpt, context: { show_title: feed.title ?? "", episode_title: episode.title, preceding, speaker_names } }, ctx.textModel);
  // An unreachable model is not a verdict on the excerpt: the queue retries a couple of times, a minute or so
  // apart, and the clip is not held longer than that. A model that refuses us (not logged in, no binary) will not
  // answer a retry either, so that settles at once. The excerpt-based title stands in; the clip is ready regardless.
  if (!result.ok && result.transport_error) {
    const message = result.problems.join("; ");
    const refused = /unauthori[sz]ed|\b401\b|not logged in|log ?in\b|ENOENT|command not found/i.test(message);
    if (!refused && job.attempts < 3) throw new Error(message);
    settleWithFallback(ctx, rev, `summary model unavailable: ${message}`);
    markReadyIfComplete(ctx, rev.id);
    throw new NonRetryable(message); // the job is failed and visible; the revision is settled already
  }
  // An owner-written title always wins; the model's title is still kept in generated_title for title evals.
  if (result.ok) {
    ctx.db.transaction(() => {
      ctx.db
        .prepare(
          `UPDATE snip_revision SET generated_title = ?, title = CASE WHEN title_source = 'owner' THEN title ELSE ? END,
             title_source = CASE WHEN title_source = 'owner' THEN 'owner' ELSE 'model' END,
             summary = ?, quote = ?, summary_model = ?, summary_prompt_version = ?, summary_status = 'ready' WHERE id = ?`,
        )
        .run(result.title, result.title, result.summary, result.quote, result.model, result.prompt_version, rev.id);
      fillGeneratedTitle(ctx, rev.id, { title: result.title, model: result.model, prompt_version: result.prompt_version });
    })();
  } else {
    ctx.db
      .prepare(
        `UPDATE snip_revision SET title = CASE WHEN title_source = 'owner' THEN title ELSE ? END,
           title_source = CASE WHEN title_source = 'owner' THEN 'owner' ELSE 'fallback' END,
           summary = NULL, quote = NULL, summary_model = ?, summary_prompt_version = ?, summary_status = 'failed', error = ? WHERE id = ?`,
      )
      .run(result.fallback_title, result.model, result.prompt_version, `summary rejected: ${result.problems.join("; ")}`.slice(0, 1000), rev.id);
  }
  ctx.log("snip summarized", { revision_id: rev.id, ok: result.ok, attempts: result.attempts });
  markReadyIfComplete(ctx, rev.id);
}

/**
 * Called by the worker when a summary job has used up its retries (the model stayed unreachable). The revision
 * still becomes ready with the excerpt-based title: a valid clip is not withheld because the model was down.
 */
export function summarizeSnipGaveUp(ctx: AppContext, job: Job<{ revision_id: string }>, error: string): void {
  const rev = getRevisionRow(ctx, job.payload.revision_id);
  if (rev.summary_status !== "pending") return;
  settleWithFallback(ctx, rev, `summary model unavailable: ${error}`);
  markReadyIfComplete(ctx, rev.id);
}

/** The model did not answer: the excerpt's first words become the title (never over the owner's), and the summary is marked failed. */
function settleWithFallback(ctx: AppContext, rev: SnipRevisionRow, error: string): void {
  const fallback = rev.excerpt ? fallbackTitleFromText(rev.excerpt) : "Snip";
  ctx.db
    .prepare(
      `UPDATE snip_revision SET title = CASE WHEN title_source = 'owner' THEN title ELSE ? END,
         title_source = CASE WHEN title_source = 'owner' THEN 'owner' ELSE 'fallback' END,
         summary = NULL, summary_status = 'failed', error = ? WHERE id = ?`,
    )
    .run(fallback, error.slice(0, 1000), rev.id);
}

/** Called by the worker when selection or rendering has used up its retries: the revision can never become ready. */
export function revisionGaveUp(ctx: AppContext, job: Job<{ revision_id: string }>, error: string): void {
  ctx.db
    .prepare("UPDATE snip_revision SET status = 'failed', error = ? WHERE id = ? AND status IN ('waiting', 'selecting', 'preparing')")
    .run(`${job.kind} failed: ${error}`.slice(0, 1000), job.payload.revision_id);
}

function isCurrent(ctx: AppContext, rev: SnipRevisionRow): boolean {
  const snip = ctx.db.prepare("SELECT current_revision_id, deleted_at FROM snip WHERE id = ?").get(rev.snip_id) as { current_revision_id: string | null; deleted_at: number | null };
  return snip.current_revision_id === rev.id && snip.deleted_at === null;
}

/** A revision is ready once its clip exists and the summary step has concluded one way or another. Then it goes to Readwise. */
function markReadyIfComplete(ctx: AppContext, revisionId: string): void {
  const ready = ctx.db
    .prepare("UPDATE snip_revision SET status = 'ready' WHERE id = ? AND status = 'preparing' AND clip_path IS NOT NULL AND summary_status != 'pending' RETURNING snip_id")
    .get(revisionId) as { snip_id: string } | undefined;
  if (ready) queueReadwiseSync(ctx, ready.snip_id);
}

/** Remove clip files of superseded revisions older than `olderThanMs`; rows stay. */
export async function pruneOldClips(ctx: AppContext, olderThanMs = 7 * 24 * 3600 * 1000): Promise<number> {
  const rows = ctx.db
    .prepare("SELECT r.id, r.clip_path, r.video_clip_path FROM snip_revision r JOIN snip s ON s.id = r.snip_id WHERE (r.clip_path IS NOT NULL OR r.video_clip_path IS NOT NULL) AND s.current_revision_id != r.id AND r.created_at < ?")
    .all(ctx.now() - olderThanMs) as { id: string; clip_path: string | null; video_clip_path: string | null }[];
  for (const r of rows) {
    if (r.clip_path) await unlink(r.clip_path).catch(() => undefined);
    if (r.video_clip_path) {
      await unlink(r.video_clip_path).catch(() => undefined);
      await unlink(posterPath(r.video_clip_path)).catch(() => undefined);
    }
    ctx.db.prepare("UPDATE snip_revision SET clip_path = NULL, video_clip_path = NULL, video_clip_sha256 = NULL WHERE id = ?").run(r.id);
  }
  return rows.length;
}
