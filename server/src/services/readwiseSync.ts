/**
 * Every snip in the owner's Readwise, when READWISE_TOKEN is set. A snip is sent once its current revision is ready,
 * sent again when its title, note or span changes, and deleted there when it is deleted here. A highlight the owner
 * deletes in Readwise stays deleted: the snip is not sent again.
 *
 * The audio stays on this server: Readwise keeps text, and the highlight's link is the snip's public page, which plays
 * the clip. The words and the owner's note go to Readwise, private feeds' included, since the account is the owner's.
 */
import type { AppContext } from "../app/context.js";
import { speakerDisplayName } from "../core/speakers/identify.js";
import { readwiseHighlight, readwisePatch, type ReadwiseSnip } from "../core/readwise/highlight.js";
import { speakerTurns } from "../core/transcript/normalize.js";
import type { SnipRevisionRow, SnipRow } from "../db/rows.js";
import { PRIORITY, type Job } from "../jobs/queue.js";
import { episodeForAsset, shareUrl } from "./snips.js";
import { speakersFor } from "./speakers.js";
import { loadTranscript } from "./transcripts.js";

/** A job that gave up (Readwise down for a while, a refused token) is tried again by the sweep after this long. */
const RETRY_FAILED_AFTER_MS = 6 * 3600 * 1000;

/** Queue a sync of one snip. Cheap to call on any change: the job reads the snip as it is when it runs. */
export function queueReadwiseSync(ctx: AppContext, snipId: string): void {
  if (!ctx.readwise) return;
  ctx.queue.enqueue("sync_readwise", `sync_readwise:${snipId}`, { snip_id: snipId }, { priority: PRIORITY.snip, rerun: true });
}

/**
 * Snips whose Readwise copy is missing or behind: never sent (every snip made before the token was set, so the first
 * sweep is the backfill), a newer revision since, or deleted here and still there. Run hourly and at start.
 */
export function queueReadwiseSweep(ctx: AppContext): number {
  if (!ctx.readwise) return 0;
  const rows = ctx.db
    .prepare(
      `SELECT s.id FROM snip s
         LEFT JOIN snip_revision r ON r.id = s.current_revision_id
         LEFT JOIN job j ON j.key = 'sync_readwise:' || s.id
        WHERE s.readwise_gone_at IS NULL
          AND ((s.deleted_at IS NULL AND r.status = 'ready' AND (s.readwise_revision_id IS NULL OR s.readwise_revision_id != s.current_revision_id))
            OR (s.deleted_at IS NOT NULL AND s.readwise_highlight_id IS NOT NULL))
          AND (j.id IS NULL OR j.status = 'done' OR (j.status = 'failed' AND j.updated_at < ?))`,
    )
    .all(ctx.now() - RETRY_FAILED_AFTER_MS) as { id: string }[];
  for (const { id } of rows) queueReadwiseSync(ctx, id);
  if (rows.length > 0) ctx.log("readwise sync queued", { snips: rows.length });
  return rows.length;
}

/** Job body: bring one snip's Readwise highlight in line with the snip. */
export async function syncReadwiseJob(ctx: AppContext, job: Job<{ snip_id: string }>): Promise<void> {
  const readwise = ctx.readwise;
  if (!readwise) return; // the token was removed since this was queued
  const snip = ctx.db.prepare("SELECT * FROM snip WHERE id = ?").get(job.payload.snip_id) as SnipRow | undefined;
  if (!snip || snip.readwise_gone_at !== null) return;

  if (snip.deleted_at !== null) {
    if (snip.readwise_highlight_id === null) return;
    await readwise.remove(snip.readwise_highlight_id);
    ctx.db.prepare("UPDATE snip SET readwise_highlight_id = NULL, readwise_synced_at = ? WHERE id = ?").run(ctx.now(), snip.id);
    ctx.log("readwise highlight deleted", { snip_id: snip.id });
    return;
  }

  const rev = snip.current_revision_id ? (ctx.db.prepare("SELECT * FROM snip_revision WHERE id = ?").get(snip.current_revision_id) as SnipRevisionRow) : null;
  if (!rev || rev.status !== "ready") return; // queued again when the revision becomes ready

  const highlight = readwiseHighlight(readwiseSnip(ctx, snip, rev));
  let id = snip.readwise_highlight_id;
  if (id !== null) {
    if ((await readwise.update(id, readwisePatch(highlight))) === "gone") {
      ctx.db.prepare("UPDATE snip SET readwise_gone_at = ? WHERE id = ?").run(ctx.now(), snip.id);
      ctx.log("readwise highlight was deleted there; not sending it again", { snip_id: snip.id, highlight_id: id });
      return;
    }
  } else {
    // Without an id from an earlier answer, the highlight_url still keeps a second create from adding a duplicate.
    id = (await readwise.create(highlight)).highlight_id;
  }
  ctx.db
    .prepare("UPDATE snip SET readwise_highlight_id = ?, readwise_revision_id = ?, readwise_synced_at = ? WHERE id = ?")
    .run(id, rev.id, ctx.now(), snip.id);
  ctx.log("readwise highlight synced", { snip_id: snip.id, revision_id: rev.id, highlight_id: id });
}

/** What the highlight is made from, read against the transcript the revision was cut from. */
export function readwiseSnip(ctx: AppContext, snip: SnipRow, rev: SnipRevisionRow): ReadwiseSnip {
  const { episode, feed } = episodeForAsset(ctx, snip.audio_asset_id);
  return {
    title: rev.title ?? "Snip",
    summary: rev.summary,
    excerpt: rev.excerpt,
    turns: namedTurns(ctx, rev),
    note: snip.note,
    episode_title: episode.title,
    show_title: feed.title,
    image_url: episode.image_url ?? feed.image_url,
    source_url: episode.link,
    start_ms: rev.start_ms,
    captured_at: snip.captured_at ?? snip.created_at,
    share_url: shareUrl(ctx, snip.share_token),
  };
}

/**
 * Who said what. Every turn is named when two or more people speak; a single speaker is named only when known by name
 * (a bare "Speaker 1" over one block says nothing). Null leaves the excerpt as one block.
 */
function namedTurns(ctx: AppContext, rev: SnipRevisionRow): ReadwiseSnip["turns"] {
  if (!rev.transcript_id || rev.start_word === null || rev.end_word === null) return null;
  const turns = speakerTurns(loadTranscript(ctx, rev.transcript_id), rev.start_word, rev.end_word);
  if (turns.length === 0) return null;
  const speakers = speakersFor(ctx, rev.transcript_id);
  const several = new Set(turns.map((t) => t.speaker)).size > 1;
  return turns.map((t) => {
    const name = speakerDisplayName(t.speaker, speakers);
    const known = speakers?.some((s) => s.label === t.speaker && s.name) ?? false;
    return { name: several || known ? name : null, text: t.text };
  });
}
