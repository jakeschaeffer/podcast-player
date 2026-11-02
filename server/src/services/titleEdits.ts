/**
 * The owner's title edits, kept as ground truth for title evals: every time the owner writes a title, the log
 * records the span, its excerpt, the title it replaced, and the title the model wrote for that span (filled in
 * later when the edit arrives before the summary). Append-only; nothing reads it at request time except the export.
 */
import type { AppContext } from "../app/context.js";
import type { SnipRevisionRow } from "../db/rows.js";
import { newId } from "../lib/ids.js";

export type TitleEditRow = {
  id: string; snip_id: string; revision_id: string;
  previous_title: string | null; previous_source: string | null; new_title: string;
  generated_title: string | null; summary_model: string | null; summary_prompt_version: string | null;
  start_ms: number; end_ms: number; excerpt: string | null; created_at: number;
};

export type TitleEditExport = TitleEditRow & { episode_id: string; episode_title: string; show_title: string | null; feed_id: string };

export function recordTitleEdit(
  ctx: AppContext,
  rev: Pick<SnipRevisionRow, "id" | "snip_id" | "start_ms" | "end_ms" | "excerpt" | "generated_title" | "summary_model" | "summary_prompt_version">,
  previous: { title: string | null; source: string | null },
  newTitle: string,
): void {
  ctx.db
    .prepare(
      `INSERT INTO title_edit (id, snip_id, revision_id, previous_title, previous_source, new_title, generated_title, summary_model, summary_prompt_version, start_ms, end_ms, excerpt, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(newId(), rev.snip_id, rev.id, previous.title, previous.source, newTitle, rev.generated_title, rev.summary_model, rev.summary_prompt_version, rev.start_ms, rev.end_ms, rev.excerpt, ctx.now());
}

/** The summary for a revision landed: give edits that were waiting for it the model's title and its provenance. */
export function fillGeneratedTitle(ctx: AppContext, revisionId: string, generated: { title: string; model: string | null; prompt_version: string | null }): void {
  ctx.db
    .prepare("UPDATE title_edit SET generated_title = ?, summary_model = ?, summary_prompt_version = ? WHERE revision_id = ? AND generated_title IS NULL")
    .run(generated.title, generated.model, generated.prompt_version, revisionId);
}

/** Every title edit with its episode and show, oldest first, for the export endpoint and the eval builder. */
export function listTitleEdits(ctx: AppContext): TitleEditExport[] {
  return ctx.db
    .prepare(
      `SELECT t.*, e.id AS episode_id, e.title AS episode_title, f.title AS show_title, f.id AS feed_id
         FROM title_edit t JOIN snip s ON s.id = t.snip_id JOIN audio_asset a ON a.id = s.audio_asset_id
         JOIN episode e ON e.id = a.episode_id JOIN feed f ON f.id = e.feed_id
        ORDER BY t.created_at`,
    )
    .all() as TitleEditExport[];
}
