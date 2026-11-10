/**
 * What the owner changed after the fact: titles rewritten and spans moved. Nothing new is recorded for this; it is
 * read from the title log and from the snips' revisions. The Prompts screen shows the counts beside each version's
 * eval score, and the selection eval turns the same spans into cases (evals/snip-selection/appSnips.ts).
 */
import type { AppContext } from "../app/context.js";
import type { SnipRevisionRow } from "../db/rows.js";

/** A chosen span is padded a little around its words and an edited one is not, so the same words differ by this much. */
export const SAME_SPAN_MS = 300;

/** Of the live snips something wrote for, how many the owner then changed. */
export type EditRate = { snips: number; edited: number };

export type ChosenSpan = {
  snip: { id: string; audio_asset_id: string; anchor_ms: number; heard_from_ms: number; episode_id: string; episode_title: string; show_title: string | null; duration_ms: number };
  /** The revision a selector chose, and the one the snip has now (the same one when nothing was moved). */
  first: SnipRevisionRow;
  current: SnipRevisionRow;
  /** The owner moved a boundary by more than the padding. */
  edited: boolean;
  start_moved_ms: number;
  end_moved_ms: number;
  /** The selector's version, and the start picker's prompt version when its pick was the one used. */
  selector: string | null;
  picker_version: string | null;
};

const unsettled = (r: SnipRevisionRow) => r.status === "waiting" || r.status === "selecting" || r.status === "failed";

/** Every live snip whose span a selector chose and whose current span is settled, oldest first. */
export function chosenSpans(ctx: AppContext): ChosenSpan[] {
  const snips = ctx.db
    .prepare(
      `SELECT s.id, s.audio_asset_id, s.anchor_ms, s.heard_from_ms, s.current_revision_id, e.id AS episode_id, e.title AS episode_title, f.title AS show_title, a.duration_ms
         FROM snip s JOIN audio_asset a ON a.id = s.audio_asset_id JOIN episode e ON e.id = a.episode_id JOIN feed f ON f.id = e.feed_id
        WHERE s.deleted_at IS NULL AND s.current_revision_id IS NOT NULL ORDER BY s.created_at`,
    )
    .all() as (ChosenSpan["snip"] & { current_revision_id: string })[];
  const firstRevision = ctx.db.prepare("SELECT * FROM snip_revision WHERE snip_id = ? ORDER BY rev LIMIT 1");
  const revision = ctx.db.prepare("SELECT * FROM snip_revision WHERE id = ?");
  const out: ChosenSpan[] = [];
  for (const { current_revision_id, ...snip } of snips) {
    const first = firstRevision.get(snip.id) as SnipRevisionRow | undefined;
    const current = revision.get(current_revision_id) as SnipRevisionRow | undefined;
    if (!first || !current || first.method === "manual" || unsettled(first) || unsettled(current)) continue;
    const start_moved_ms = current.start_ms - first.start_ms;
    const end_moved_ms = current.end_ms - first.end_ms;
    let selection: { version?: string; picker_prompt_version?: string } = {};
    try {
      selection = JSON.parse(first.selection ?? "{}") as typeof selection;
    } catch {
      // an unreadable selection record loses only the versions' names
    }
    out.push({
      snip, first, current, start_moved_ms, end_moved_ms,
      edited: current.id !== first.id && (Math.abs(start_moved_ms) > SAME_SPAN_MS || Math.abs(end_moved_ms) > SAME_SPAN_MS),
      selector: selection.version ?? null,
      picker_version: first.method === "model" ? (selection.picker_prompt_version ?? null) : null,
    });
  }
  return out;
}

/** Spans moved, by what chose them: each start-picker version whose pick was used, and the fixed rules for the rest. */
export function boundaryEditRates(ctx: AppContext): { rules: EditRate; versions: Map<string, EditRate> } {
  const rules: EditRate = { snips: 0, edited: 0 };
  const versions = new Map<string, EditRate>();
  for (const span of chosenSpans(ctx)) {
    let rate = rules;
    if (span.picker_version) {
      rate = versions.get(span.picker_version) ?? { snips: 0, edited: 0 };
      versions.set(span.picker_version, rate);
    }
    rate.snips++;
    if (span.edited) rate.edited++;
  }
  return { rules, versions };
}

/**
 * Titles rewritten, by the snip-summary version that wrote the title the owner replaced. A snip counts once per
 * version however often its title was edited; the owner rewriting their own title is not a rewrite of the model's.
 */
export function titleRewriteRates(ctx: AppContext): Map<string, EditRate> {
  const out = new Map<string, EditRate>();
  const wrote = ctx.db
    .prepare(
      `SELECT r.summary_prompt_version AS version, COUNT(DISTINCT s.id) AS n FROM snip s JOIN snip_revision r ON r.snip_id = s.id
        WHERE s.deleted_at IS NULL AND r.generated_title IS NOT NULL AND r.summary_prompt_version IS NOT NULL GROUP BY r.summary_prompt_version`,
    )
    .all() as { version: string; n: number }[];
  for (const w of wrote) out.set(w.version, { snips: w.n, edited: 0 });
  // The replaced title's version is that of the revision the model wrote it for; the log's own column names the
  // version of the edited revision's summary, which differs when the summary was written again for a new span.
  const rewritten = ctx.db
    .prepare(
      `SELECT version, COUNT(DISTINCT snip_id) AS n FROM (
         SELECT t.snip_id, COALESCE(
                  (SELECT r.summary_prompt_version FROM snip_revision r
                    WHERE r.snip_id = t.snip_id AND r.generated_title = t.previous_title AND r.summary_prompt_version IS NOT NULL ORDER BY r.rev LIMIT 1),
                  t.summary_prompt_version) AS version
           FROM title_edit t JOIN snip s ON s.id = t.snip_id
          WHERE s.deleted_at IS NULL AND t.previous_source = 'model')
        WHERE version IS NOT NULL GROUP BY version`,
    )
    .all() as { version: string; n: number }[];
  for (const r of rewritten) {
    const rate = out.get(r.version);
    if (rate) rate.edited = Math.min(r.n, rate.snips);
  }
  return out;
}
