/**
 * Snips as the owner sees them: create (idempotent), list, edit, revoke, restore, delete, and the views the API
 * returns. The recipient side lives in publicSnips.ts and the pipeline jobs in snipJobs.ts.
 */
import type { AppContext } from "../app/context.js";
import { badRequest, conflict, notFound } from "../app/errors.js";
import { wordRangeByMidpoint } from "../core/snip/select.js";
import { quoteKey } from "../core/summary/snip.js";
import { sliceWords } from "../core/transcript/normalize.js";
import type { EpisodeRow, FeedRow, SnipRevisionRow, SnipRow } from "../db/rows.js";
import { PRIORITY } from "../jobs/queue.js";
import { newId, newShareToken } from "../lib/ids.js";
import { getAssetRow } from "./episodes.js";
import { queueReadwiseSync, readwiseState, type ReadwiseSnipState } from "./readwiseSync.js";
import { recordTitleEdit } from "./titleEdits.js";
import { signMediaUrl } from "./media.js";
import { transcriptForAsset } from "./transcripts.js";

export type RevisionView = {
  id: string; rev: number; method: SnipRevisionRow["method"]; status: SnipRevisionRow["status"]; transcript_id: string | null;
  start_ms: number; end_ms: number; start_word: number | null; end_word: number | null;
  excerpt: string | null; title: string | null; title_source: SnipRevisionRow["title_source"]; summary: string | null; quote: string | null; summary_status: SnipRevisionRow["summary_status"];
  clip_url: string | null; clip_duration_ms: number | null; error: string | null; selection: unknown; created_at: number;
};

export type SnipView = {
  id: string; asset_id: string; episode_id: string; episode_title: string; show_title: string | null; image_url: string | null;
  /** Which of the episode's recordings the snip was cut from: its video, or its audio. */
  media_kind: "audio" | "video";
  anchor_ms: number; heard_from_ms: number; share_url: string; share_state: SnipRow["share_state"]; note: string | null;
  created_at: number; captured_at: number; revision: RevisionView | null;
  /** How the snip stands with the owner's Readwise; null when Readwise is not set up. */
  readwise: ReadwiseSnipState | null;
};

/** What the owner changed on the device while the tap waited to be sent. The span is both ends or neither. */
export type OwnerEdit = { start_ms?: number; end_ms?: number; title?: string; note?: string };
export type CreateSnipInput = { client_request_id: string; asset_id: string; anchor_ms: number; heard_from_ms: number; captured_at?: number; owner?: OwnerEdit };
export type EditSnipInput = {
  start_ms?: number; end_ms?: number; start_word?: number; end_word?: number; transcript_id?: string; snap?: boolean; note?: string | null; title?: string; if_revision?: string;
  regenerate_summary?: boolean;
};

/** A boundary edit that changes the snip's length by more than this writes the title and summary again by default. */
export const RESUMMARIZE_OVER_MS = 10_000;

const FIXED_TARGET_MS = 60_000;

export function shareUrl(ctx: AppContext, token: string): string {
  return `${ctx.config.publicBaseUrl}/s/${token}`;
}

export function getSnipRow(ctx: AppContext, id: string): SnipRow {
  const row = ctx.db.prepare("SELECT * FROM snip WHERE id = ? AND deleted_at IS NULL").get(id) as SnipRow | undefined;
  if (!row) throw notFound("snip");
  return row;
}

export function getRevisionRow(ctx: AppContext, id: string): SnipRevisionRow {
  const row = ctx.db.prepare("SELECT * FROM snip_revision WHERE id = ?").get(id) as SnipRevisionRow | undefined;
  if (!row) throw notFound("snip revision");
  return row;
}

/** The episode and show a recording belongs to, and whether the recording is a video. */
export function episodeForAsset(ctx: AppContext, assetId: string): { episode: EpisodeRow; feed: FeedRow; video: boolean } {
  const row = ctx.db
    .prepare("SELECT e.id AS episode_id, f.id AS feed_id, a.video_path IS NOT NULL AS video FROM audio_asset a JOIN episode e ON e.id = a.episode_id JOIN feed f ON f.id = e.feed_id WHERE a.id = ?")
    .get(assetId) as { episode_id: string; feed_id: string; video: number };
  return {
    episode: ctx.db.prepare("SELECT * FROM episode WHERE id = ?").get(row.episode_id) as EpisodeRow,
    feed: ctx.db.prepare("SELECT * FROM feed WHERE id = ?").get(row.feed_id) as FeedRow,
    video: row.video === 1,
  };
}

export function toRevisionView(ctx: AppContext, r: SnipRevisionRow, deviceId: string | null): RevisionView {
  return {
    id: r.id, rev: r.rev, method: r.method, status: r.status, transcript_id: r.transcript_id,
    start_ms: r.start_ms, end_ms: r.end_ms, start_word: r.start_word, end_word: r.end_word,
    excerpt: r.excerpt, title: r.title, title_source: r.title_source, summary: r.summary, quote: r.quote, summary_status: r.summary_status,
    clip_url: r.clip_path && deviceId ? signMediaUrl(ctx, "clip", r.id, deviceId) : null,
    clip_duration_ms: r.clip_duration_ms, error: r.error, selection: r.selection ? JSON.parse(r.selection) : null, created_at: r.created_at,
  };
}

export function toSnipView(ctx: AppContext, s: SnipRow, deviceId: string | null): SnipView {
  const { episode, feed, video } = episodeForAsset(ctx, s.audio_asset_id);
  const rev = s.current_revision_id ? getRevisionRow(ctx, s.current_revision_id) : null;
  return {
    id: s.id, asset_id: s.audio_asset_id, episode_id: episode.id, episode_title: episode.title, show_title: feed.title, image_url: episode.image_url ?? feed.image_url, media_kind: video ? "video" : "audio",
    anchor_ms: s.anchor_ms, heard_from_ms: s.heard_from_ms, share_url: shareUrl(ctx, s.share_token), share_state: s.share_state, note: s.note,
    created_at: s.created_at, captured_at: s.captured_at ?? s.created_at, revision: rev ? toRevisionView(ctx, rev, deviceId) : null,
    readwise: readwiseState(ctx, s),
  };
}

export function getSnip(ctx: AppContext, id: string, deviceId: string | null): SnipView {
  return toSnipView(ctx, getSnipRow(ctx, id), deviceId);
}

export function listSnips(ctx: AppContext, deviceId: string | null, opts: { asset_id?: string; episode_id?: string; q?: string; after?: string; limit?: number } = {}): { items: SnipView[]; next: string | null } {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const where = ["s.deleted_at IS NULL"];
  const args: unknown[] = [];
  if (opts.asset_id) { where.push("s.audio_asset_id = ?"); args.push(opts.asset_id); }
  if (opts.episode_id) { where.push("a.episode_id = ?"); args.push(opts.episode_id); }
  if (opts.q) {
    const like = `%${opts.q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    where.push("(r.excerpt LIKE ? ESCAPE '\\' OR r.title LIKE ? ESCAPE '\\' OR r.summary LIKE ? ESCAPE '\\' OR s.note LIKE ? ESCAPE '\\')");
    args.push(like, like, like, like);
  }
  // One episode's snips are one thread in the episode's time, whichever of its recordings (audio, video) each was
  // cut from: ordered by where they start, with no paging. Every other list is newest first, paged by id.
  const byStart = opts.episode_id !== undefined && opts.asset_id === undefined;
  if (opts.after && !byStart) { where.push("s.id < ?"); args.push(opts.after); }
  const order = byStart ? "COALESCE(r.start_ms, s.anchor_ms) ASC, s.id ASC" : "s.id DESC";
  const rows = ctx.db
    .prepare(`SELECT s.* FROM snip s JOIN audio_asset a ON a.id = s.audio_asset_id LEFT JOIN snip_revision r ON r.id = s.current_revision_id WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ?`)
    .all(...args, limit + 1) as SnipRow[];
  const page = rows.slice(0, limit);
  return { items: page.map((s) => toSnipView(ctx, s, deviceId)), next: rows.length > limit && !byStart ? page[page.length - 1]!.id : null };
}

/**
 * Persist the tap and allocate the public link immediately. Idempotent on `client_request_id`.
 * Selection, rendering, and summarization run as jobs; the owner sees a fixed provisional range meanwhile.
 */
export function createSnip(ctx: AppContext, input: CreateSnipInput, deviceId: string | null): { snip: SnipView; created: boolean } {
  const existing = ctx.db.prepare("SELECT * FROM snip WHERE client_request_id = ?").get(input.client_request_id) as SnipRow | undefined;
  if (existing) return { snip: toSnipView(ctx, existing, deviceId), created: false };
  const asset = getAssetRow(ctx, input.asset_id);
  if (!(input.anchor_ms >= 0 && input.anchor_ms <= asset.duration_ms)) throw badRequest("anchor_ms is outside the recording");
  const anchor = Math.round(input.anchor_ms);
  const heardFrom = Math.max(0, Math.min(anchor, Math.round(input.heard_from_ms)));
  const now = ctx.now();
  // A tap replayed from an offline outbox keeps the time it was made; a device clock running fast cannot postdate it.
  const capturedAt = input.captured_at !== undefined ? Math.min(Math.round(input.captured_at), now) : null;
  const snipId = newId();
  const revisionId = newId();
  const provisionalStart = Math.max(heardFrom, anchor - FIXED_TARGET_MS, 0);
  const hasTranscript = asset.transcript_id !== null;
  // The owner's own span and title wait on the row until the selector has chosen (applyOwnerEdit); the note needs
  // no revision and is saved now.
  const owner = input.owner ?? {};
  const span = owner.start_ms !== undefined && owner.end_ms !== undefined ? { start_ms: Math.round(owner.start_ms), end_ms: Math.round(owner.end_ms) } : null;
  if ((owner.start_ms === undefined) !== (owner.end_ms === undefined)) throw badRequest("owner.start_ms and owner.end_ms go together");
  if (span && !(span.start_ms >= 0 && span.start_ms < span.end_ms && span.end_ms <= asset.duration_ms)) throw badRequest("owner span must satisfy 0 <= start < end <= duration");
  const title = owner.title?.trim().slice(0, 120) || undefined;
  const ownerEdit = span || title ? JSON.stringify({ ...(span ?? {}), ...(title ? { title } : {}) }) : null;
  const note = owner.note?.trim() || null;
  ctx.db.transaction(() => {
    ctx.db
      .prepare("INSERT INTO snip (id, audio_asset_id, anchor_ms, heard_from_ms, client_request_id, share_token, share_state, current_revision_id, created_at, captured_at, owner_edit, note) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)")
      .run(snipId, asset.id, anchor, heardFrom, input.client_request_id, newShareToken(), revisionId, now, capturedAt, ownerEdit, note);
    ctx.db
      .prepare("INSERT INTO snip_revision (id, snip_id, rev, method, transcript_id, start_ms, end_ms, status, summary_status, created_at) VALUES (?, ?, 1, 'fixed', ?, ?, ?, ?, 'pending', ?)")
      .run(revisionId, snipId, asset.transcript_id, provisionalStart, anchor, hasTranscript ? "selecting" : "waiting", now);
    ctx.db.prepare("UPDATE audio_asset SET pinned = 1 WHERE id = ?").run(asset.id);
  })();
  ctx.queue.enqueue("select_snip", `select_snip:${revisionId}`, { revision_id: revisionId }, { priority: PRIORITY.snip });
  if (!hasTranscript) ctx.queue.enqueue("transcribe", `transcribe:${asset.id}`, { asset_id: asset.id }, { priority: PRIORITY.snip });
  return { snip: getSnip(ctx, snipId, deviceId), created: true };
}

/**
 * Owner edit. Boundary changes create a new revision; note and title edits apply in place. A title the owner
 * writes belongs to the revision that is current after the edit, survives later boundary edits, and is logged with
 * the span and the model's title as ground truth for title evals.
 *
 * Fine-tuning In and Out keeps the words around them: the new revision carries the previous title, summary and quote
 * (the quote only while it is still inside the new excerpt) and only its clip is rendered again. A revision without a
 * finished summary has nothing to keep, so its edit always gets one. The title and summary
 * are written again only when `regenerate_summary` says so, or, when it is left out, when the length changes by more
 * than RESUMMARIZE_OVER_MS. The app asks the owner before such a change.
 */
export function editSnip(ctx: AppContext, id: string, patch: EditSnipInput, deviceId: string | null): SnipView {
  const snip = getSnipRow(ctx, id);
  const wantsWords = patch.start_word !== undefined || patch.end_word !== undefined;
  const wantsBoundary = wantsWords || patch.start_ms !== undefined || patch.end_ms !== undefined;
  // Without if_revision a replayed boundary edit (an offline outbox resending after a lost response) would add a
  // second revision. Title and note edits apply in place, so replaying them is harmless and they may omit it.
  if (wantsBoundary && patch.if_revision === undefined) throw badRequest("if_revision is required when moving boundaries");
  if (patch.if_revision !== undefined && patch.if_revision !== snip.current_revision_id) throw conflict("snip was edited elsewhere; reload and retry");
  if (patch.note !== undefined) ctx.db.prepare("UPDATE snip SET note = ? WHERE id = ?").run(patch.note, id);
  const before = snip.current_revision_id ? getRevisionRow(ctx, snip.current_revision_id) : null;
  const ownerTitle = patch.title !== undefined ? patch.title.trim().slice(0, 120) : undefined;
  const titleChanged = ownerTitle !== undefined && ownerTitle !== "" && ownerTitle !== (before?.title ?? null);
  if (!wantsBoundary) {
    if (titleChanged && before) {
      ctx.db.transaction(() => {
        ctx.db.prepare("UPDATE snip_revision SET title = ?, title_source = 'owner' WHERE id = ?").run(ownerTitle, before.id);
        recordTitleEdit(ctx, before, { title: before.title, source: before.title_source }, ownerTitle);
      })();
    }
    if (titleChanged || patch.note !== undefined) queueReadwiseSync(ctx, id);
    return getSnip(ctx, id, deviceId);
  }

  const asset = getAssetRow(ctx, snip.audio_asset_id);
  const current = snip.current_revision_id ? getRevisionRow(ctx, snip.current_revision_id) : null;
  const transcript = transcriptForAsset(ctx, asset);
  let start_ms = patch.start_ms ?? current?.start_ms ?? 0;
  let end_ms = patch.end_ms ?? current?.end_ms ?? asset.duration_ms;
  let start_word: number | null = null;
  let end_word: number | null = null;

  if (wantsWords) {
    if (!transcript) throw badRequest("word boundaries need a transcript");
    // Word indices only mean something against one transcript, and the asset's current one can change between the
    // client loading it and this edit. Both ends and the transcript they index are therefore required together.
    if (patch.start_word === undefined || patch.end_word === undefined) throw badRequest("send start_word and end_word together");
    if (patch.transcript_id === undefined) throw badRequest("transcript_id is required with start_word and end_word");
    if (patch.transcript_id !== asset.transcript_id) throw conflict("the transcript changed; reload and retry");
    start_word = patch.start_word;
    end_word = patch.end_word;
    if (!(start_word >= 0 && end_word <= transcript.word_count && start_word < end_word)) throw badRequest("word range is invalid");
    const words = sliceWords(transcript, start_word, end_word);
    start_ms = words[0]![0];
    end_ms = words[words.length - 1]![1];
  } else if (transcript && patch.snap !== false) {
    const range = wordRangeByMidpoint(transcript, start_ms, end_ms);
    if (range) {
      start_word = range.start_word;
      end_word = range.end_word;
      const words = sliceWords(transcript, start_word, end_word);
      start_ms = Math.min(start_ms, words[0]![0]);
      end_ms = Math.max(end_ms, words[words.length - 1]![1]);
    }
  } else if (transcript) {
    const range = wordRangeByMidpoint(transcript, start_ms, end_ms);
    start_word = range?.start_word ?? null;
    end_word = range?.end_word ?? null;
  }
  start_ms = Math.round(start_ms);
  end_ms = Math.round(end_ms);
  if (!(start_ms >= 0 && end_ms <= asset.duration_ms && start_ms < end_ms)) throw badRequest("range must satisfy 0 <= start < end <= duration");

  const excerpt = transcript && start_word !== null && end_word !== null ? sliceWords(transcript, start_word, end_word).map((w) => w[2]).join(" ") : null;
  const revisionId = newId();
  const now = ctx.now();
  const rev = (current?.rev ?? 0) + 1;
  const lengthChangeMs = current ? Math.abs(end_ms - start_ms - (current.end_ms - current.start_ms)) : Infinity;
  // Only a finished summary is worth keeping; without one (no model at the time, or it failed) the new span gets one.
  const regenerate = !current || current.summary_status !== "ready" || (patch.regenerate_summary ?? lengthChangeMs > RESUMMARIZE_OVER_MS);
  // Regenerating, the new revision takes the owner's title from this edit or keeps one the owner wrote earlier, and
  // the summary job writes the rest. Keeping, it carries everything the previous revision had.
  const kept = !regenerate && current ? current : null;
  const carried = titleChanged ? ownerTitle : current?.title_source === "owner" ? current.title : (kept?.title ?? null);
  const carriedSource = titleChanged ? "owner" : carried === null ? null : (current?.title_source ?? null);
  const keptQuote = kept?.quote && excerpt && quoteKey(excerpt).includes(quoteKey(kept.quote)) ? kept.quote : null;
  ctx.db.transaction(() => {
    ctx.db
      .prepare(
        `INSERT INTO snip_revision (id, snip_id, rev, method, transcript_id, start_ms, end_ms, start_word, end_word, excerpt, title, title_source,
           generated_title, summary, quote, summary_model, summary_prompt_version, status, summary_status, selection, created_at)
         VALUES (?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'preparing', ?, ?, ?)`,
      )
      .run(
        revisionId, id, rev, asset.transcript_id, start_ms, end_ms, start_word, end_word, excerpt, carried, carriedSource,
        kept?.generated_title ?? null, kept?.summary ?? null, keptQuote, kept?.summary_model ?? null, kept?.summary_prompt_version ?? null,
        kept ? kept.summary_status : "pending",
        JSON.stringify({ edited_from: current?.id ?? null, snap: patch.snap !== false, ...(kept ? { summary_kept_from: kept.id } : {}) }), now,
      );
    ctx.db.prepare("UPDATE snip SET current_revision_id = ? WHERE id = ?").run(revisionId, id);
    if (titleChanged) {
      // With the summary kept, no summary job runs for this revision to fill the log later: the model's title goes in now.
      recordTitleEdit(
        ctx,
        { id: revisionId, snip_id: id, start_ms, end_ms, excerpt, generated_title: kept?.generated_title ?? null, summary_model: kept?.summary_model ?? null, summary_prompt_version: kept?.summary_prompt_version ?? null },
        { title: current?.title ?? null, source: current?.title_source ?? null },
        ownerTitle,
      );
    }
  })();
  if (current) ctx.log("snip edited", { snip_id: id, from: { start_ms: current.start_ms, end_ms: current.end_ms, method: current.method }, to: { start_ms, end_ms }, regenerate });
  if (kept) ctx.queue.enqueue("render_clip", `render_clip:${revisionId}`, { revision_id: revisionId }, { priority: PRIORITY.snip });
  else enqueuePreparation(ctx, revisionId);
  return getSnip(ctx, id, deviceId);
}

/**
 * The selector has chosen revision 1's span. If the owner already edited this tap on the device, their edit goes over
 * it now, as any later edit would: a title in place, a span as a manual revision (so the selector's choice stays on
 * record, and nothing is rendered or titled for a span the owner already replaced). Returns true when a new revision
 * took over and is being prepared; false when revision 1 still needs preparing.
 */
export function applyOwnerEdit(ctx: AppContext, snipId: string, revisionId: string): boolean {
  const row = ctx.db.prepare("SELECT owner_edit FROM snip WHERE id = ?").get(snipId) as { owner_edit: string | null };
  if (!row.owner_edit) return false;
  const edit = JSON.parse(row.owner_edit) as OwnerEdit;
  ctx.db.prepare("UPDATE snip SET owner_edit = NULL WHERE id = ?").run(snipId);
  try {
    editSnip(ctx, snipId, { ...edit, if_revision: revisionId }, null);
  } catch (e) {
    // A span that no longer fits (the recording was replaced) is not worth failing the snip for.
    ctx.log("owner edit from the device not applied", { snip_id: snipId, error: String(e) });
    return false;
  }
  return edit.start_ms !== undefined;
}

/** Queue the clip render, its picture if the recording has one, and the summary for a revision whose span is settled. */
export function enqueuePreparation(ctx: AppContext, revisionId: string): void {
  ctx.queue.enqueue("render_clip", `render_clip:${revisionId}`, { revision_id: revisionId }, { priority: PRIORITY.snip });
  ctx.queue.enqueue("summarize_snip", `summarize_snip:${revisionId}`, { revision_id: revisionId }, { priority: PRIORITY.snip });
  ctx.queue.enqueue("render_video_clip", `render_video_clip:${revisionId}`, { revision_id: revisionId }, { priority: PRIORITY.snip });
}

export function revokeSnip(ctx: AppContext, id: string, deviceId: string | null): SnipView {
  getSnipRow(ctx, id);
  ctx.db.prepare("UPDATE snip SET share_state = 'revoked' WHERE id = ?").run(id);
  return getSnip(ctx, id, deviceId);
}

export function restoreSnip(ctx: AppContext, id: string, deviceId: string | null): SnipView {
  getSnipRow(ctx, id);
  ctx.db.prepare("UPDATE snip SET share_state = 'active' WHERE id = ?").run(id);
  return getSnip(ctx, id, deviceId);
}

/** Idempotent: deleting a snip that is already deleted succeeds, so a replayed DELETE is harmless. */
export function deleteSnip(ctx: AppContext, id: string): void {
  const row = ctx.db.prepare("SELECT deleted_at FROM snip WHERE id = ?").get(id) as { deleted_at: number | null } | undefined;
  if (!row) throw notFound("snip");
  if (row.deleted_at !== null) return;
  ctx.db.prepare("UPDATE snip SET deleted_at = ?, share_state = 'revoked' WHERE id = ?").run(ctx.now(), id);
  queueReadwiseSync(ctx, id);
}
