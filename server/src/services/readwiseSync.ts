/**
 * Every snip in the owner's Readwise, when READWISE_TOKEN is set. A snip is sent once its current revision is ready,
 * sent again when its title, note or span changes, and deleted there when it is deleted here. A highlight the owner
 * deletes in Readwise stays deleted: the snip is not sent again.
 *
 * The audio stays on this server: Readwise keeps text, and the highlight's link is the snip's public page, which plays
 * the clip. The words and the owner's note go to Readwise, private feeds' included, since the account is the owner's.
 */
import type { AppContext } from "../app/context.js";
import { conflict } from "../app/errors.js";
import { speakerDisplayName } from "../core/speakers/identify.js";
import { READWISE_FORMAT, readwiseHighlight, readwisePatch, type ReadwiseSnip } from "../core/readwise/highlight.js";
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
 * sweep is the backfill), a newer revision since, or deleted here and still there. Run hourly and at start. After a
 * change of layout (READWISE_FORMAT) every highlight already there is sent again once.
 */
export function queueReadwiseSweep(ctx: AppContext): number {
  if (!ctx.readwise) return 0;
  const queued = new Set<string>();
  const sentFormat = ctx.db.prepare("SELECT value FROM setting WHERE key = 'readwise_format'").pluck().get() as string | undefined;
  if (sentFormat !== READWISE_FORMAT) {
    // Queued before the row is written, so a crash in between sends them again rather than never.
    const sent = ctx.db
      .prepare("SELECT s.id FROM snip s WHERE s.deleted_at IS NULL AND s.readwise_gone_at IS NULL AND s.readwise_revision_id IS NOT NULL")
      .pluck()
      .all() as string[];
    for (const id of sent) queued.add(id);
    for (const id of sent) queueReadwiseSync(ctx, id);
    ctx.db.prepare("INSERT INTO setting (key, value) VALUES ('readwise_format', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(READWISE_FORMAT);
    if (sent.length > 0) ctx.log("readwise layout changed; sending every highlight again", { snips: sent.length, format: READWISE_FORMAT });
  }
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
  for (const { id } of rows) {
    queued.add(id);
    queueReadwiseSync(ctx, id);
  }
  if (rows.length > 0) ctx.log("readwise sync queued", { snips: rows.length });
  return queued.size;
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
 * Who said what, with the headings every client shows (speakerDisplayName). A turn is named when two or more voices
 * speak, or when its name is a person's: a bare "Speaker 1" or "Host" over one block says nothing. Null leaves the
 * excerpt as one block.
 *
 * Unnamed text (the author's prose, the passages it quotes) runs on as the article does, with a new paragraph only
 * where a sentence ends: aligning the audio to the article's paragraphs can be a few words off at their edges, so a
 * quoted passage's last words may carry the prose's label, and marking quotes would cut sentences in two.
 */
function namedTurns(ctx: AppContext, rev: SnipRevisionRow): ReadwiseSnip["turns"] {
  if (!rev.transcript_id || rev.start_word === null || rev.end_word === null) return null;
  const turns = speakerTurns(loadTranscript(ctx, rev.transcript_id), rev.start_word, rev.end_word);
  if (turns.length === 0) return null;
  const speakers = speakersFor(ctx, rev.transcript_id);
  const voice = (label: string | null) => speakerDisplayName(label, speakers);
  const several = new Set(turns.map((t) => voice(t.speaker)).filter(Boolean)).size > 1;
  const out: { name: string | null; text: string }[] = [];
  for (const t of turns) {
    const name = voice(t.speaker);
    const shown = name !== null && (several || !GENERIC_NAME.test(name)) ? name : null;
    const last = out[out.length - 1];
    if (last && last.name === null && shown === null && !SENTENCE_END.test(last.text)) last.text += ` ${t.text}`;
    else out.push({ name: shown, text: t.text });
  }
  return out;
}

const GENERIC_NAME = /^(Speaker( \d+)?|Host|Guest)$/;
const SENTENCE_END = /[.!?…]["”’)\]]*$/;

/**
 * Where one snip stands with Readwise: in it with its current revision ("sent"), still to go or behind an edit
 * ("waiting"), given up on until the next sweep or a retry ("failed", with the error), or deleted there by the owner.
 */
export type ReadwiseSnipState = {
  state: "sent" | "waiting" | "failed" | "deleted_in_readwise";
  /** The highlight in Readwise, once it has an id. */
  highlight_url: string | null;
  synced_at: number | null;
  error: string | null;
};

/** Null when Readwise is not set up (no READWISE_TOKEN). */
export function readwiseState(ctx: AppContext, snip: SnipRow): ReadwiseSnipState | null {
  if (!ctx.readwise) return null;
  const job = ctx.db.prepare("SELECT status, last_error FROM job WHERE key = ?").get(`sync_readwise:${snip.id}`) as { status: string; last_error: string | null } | undefined;
  const state: ReadwiseSnipState["state"] =
    snip.readwise_gone_at !== null ? "deleted_in_readwise"
    : job?.status === "failed" ? "failed"
    : snip.readwise_revision_id !== null && snip.readwise_revision_id === snip.current_revision_id ? "sent"
    : "waiting";
  return {
    state,
    highlight_url: snip.readwise_highlight_id !== null && state !== "deleted_in_readwise" ? highlightUrl(snip.readwise_highlight_id) : null,
    synced_at: snip.readwise_synced_at,
    error: state === "failed" ? (job?.last_error ?? null) : null,
  };
}

export const highlightUrl = (id: number) => `https://readwise.io/open/${id}`;

/** A send Readwise refused or that kept failing; it is tried again by the sweep after a while, or by a retry. */
export type ReadwiseFailure = { snip_id: string; title: string; episode_title: string; snip_deleted: boolean; error: string; failed_at: number };

export type ReadwiseSummary = {
  enabled: boolean;
  days: number;
  since: number;
  /** Ready snips made in the window, less those the owner deleted in Readwise. */
  snips: number;
  /** Of those, how many have a highlight in Readwise now (an edit may still be on its way). */
  sent: number;
  /** Of those, how many are still to be sent for the first time. */
  waiting: number;
  /** Snips in the window the owner deleted in Readwise, which are not sent again. */
  deleted_in_readwise: number;
  /** Every send that has failed for good, whenever its snip was made, newest first. */
  failed: ReadwiseFailure[];
};

/** How the last `days` of snips stand with Readwise, and every failed send. */
export function readwiseSummary(ctx: AppContext, days = 30): ReadwiseSummary {
  const since = ctx.now() - days * 86_400_000;
  if (!ctx.readwise) return { enabled: false, days, since, snips: 0, sent: 0, waiting: 0, deleted_in_readwise: 0, failed: [] };
  const counts = ctx.db
    .prepare(
      `SELECT
         COUNT(*) FILTER (WHERE s.readwise_gone_at IS NULL) AS snips,
         COUNT(*) FILTER (WHERE s.readwise_gone_at IS NULL AND s.readwise_revision_id IS NOT NULL) AS sent,
         COUNT(*) FILTER (WHERE s.readwise_gone_at IS NULL AND s.readwise_revision_id IS NULL AND (j.status IS NULL OR j.status != 'failed')) AS waiting,
         COUNT(*) FILTER (WHERE s.readwise_gone_at IS NOT NULL) AS deleted_in_readwise
         FROM snip s
         JOIN snip_revision r ON r.id = s.current_revision_id
         LEFT JOIN job j ON j.key = 'sync_readwise:' || s.id
        WHERE s.deleted_at IS NULL AND r.status = 'ready' AND COALESCE(s.captured_at, s.created_at) >= ?`,
    )
    .get(since) as { snips: number; sent: number; waiting: number; deleted_in_readwise: number };
  const failed = ctx.db
    .prepare(
      `SELECT s.id, s.audio_asset_id, s.deleted_at, r.title, r.excerpt, j.last_error, j.updated_at
         FROM job j JOIN snip s ON j.key = 'sync_readwise:' || s.id
         LEFT JOIN snip_revision r ON r.id = s.current_revision_id
        WHERE j.kind = 'sync_readwise' AND j.status = 'failed' AND s.readwise_gone_at IS NULL
        ORDER BY j.updated_at DESC LIMIT 100`,
    )
    .all() as { id: string; audio_asset_id: string; deleted_at: number | null; title: string | null; excerpt: string | null; last_error: string | null; updated_at: number }[];
  return {
    enabled: true,
    days,
    since,
    ...counts,
    failed: failed.map((f) => ({
      snip_id: f.id,
      title: f.title ?? "Snip",
      episode_title: episodeForAsset(ctx, f.audio_asset_id).episode.title,
      snip_deleted: f.deleted_at !== null,
      error: f.last_error ?? "failed",
      failed_at: f.updated_at,
    })),
  };
}

/** Queue every failed send again now. Idempotent: what is not failed is left as it is. Returns how many were queued. */
export function retryReadwiseFailures(ctx: AppContext): number {
  if (!ctx.readwise) throw conflict("Readwise is not set up on this server (READWISE_TOKEN)");
  const ids = ctx.db
    .prepare("SELECT s.id FROM job j JOIN snip s ON j.key = 'sync_readwise:' || s.id WHERE j.kind = 'sync_readwise' AND j.status = 'failed' AND s.readwise_gone_at IS NULL")
    .pluck()
    .all() as string[];
  for (const id of ids) queueReadwiseSync(ctx, id);
  if (ids.length > 0) ctx.log("readwise failures queued again", { snips: ids.length });
  return ids.length;
}
