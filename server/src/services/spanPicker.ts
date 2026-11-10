import { Type } from "@sinclair/typebox";
import { delimited, type TextModel } from "../adapters/textModel.js";
import { WIDE_REACH_MS, type SpanPicker } from "../core/snip/select.js";
import { resolvePrompt } from "../core/summary/prompts.js";

const PickSchema = Type.Object({ start_id: Type.Integer(), reason: Type.String({ maxLength: 300 }) }, { additionalProperties: false });

/**
 * The model moves the start among offered candidates; the selector validates the pick. The prompt version is fixed when
 * the picker is made (the active one unless `version` names another) and exposed so selections can record it.
 *
 * v1 was written for a handful of candidates around the default and keeps them, so its scores stay comparable. Every
 * later version asks for reach (`WIDE_REACH_MS`): it may start the snip at any sentence that far back, and is shown
 * the passage as a range with each sentence's distance from the end.
 */
export function makeSpanPicker(model: TextModel, opts: { timeout_ms?: number; version?: string } = {}): SpanPicker & { prompt_version: string } {
  const prompt = resolvePrompt("span-picker", opts.version);
  const reach_ms = prompt.version === "v1" ? undefined : WIDE_REACH_MS;
  const pick: SpanPicker = async ({ sentences, end_id, snap_start_id, candidate_start_ids, prefs, short_exception }) => {
    if (candidate_start_ids.length <= 1) return candidate_start_ids.length === 1 ? { start_id: candidate_start_ids[0]!, reason: "only candidate" } : null;
    if (reach_ms !== undefined) {
      const [lowest, highest] = [Math.min(...candidate_start_ids), Math.max(...candidate_start_ids)];
      const end = sentences[end_id]!;
      const lines = sentences
        .filter((s) => s.id >= Math.max(0, lowest - 2) && s.id <= end_id)
        .map((s) => {
          const marks = [s.id === snap_start_id ? "DEFAULT" : null, s.id === end_id ? "END" : null, s.id < lowest || (s.id > highest && s.id !== end_id) ? "not a start" : null].filter((m) => m !== null);
          return `[${s.id}]${marks.length ? ` (${marks.join("; ")})` : ""} ${Math.round((end.end_ms - s.start_ms) / 1000)}s ${s.speaker ?? "-"}: ${s.text}`;
        });
      const range = candidate_start_ids.length === highest - lowest + 1 ? `any sentence from ${lowest} to ${highest}` : `one of: ${candidate_start_ids.join(", ")}`;
      const rule = short_exception
        ? "This window is shorter than the usual minimum; any start in the range is acceptable."
        : `Any start in the range gives a snip between ${Math.round(prefs.min_ms / 1000)} and ${Math.round(Math.max(prefs.max_ms, reach_ms) / 1000)} seconds long.`;
      const user = [
        `The snip may start at ${range}. Default: ${snap_start_id}. End: ${end_id}. The number after each id is how many seconds before the end of the snip that sentence starts.`,
        rule,
        delimited("transcript", lines.join("\n")),
      ].join("\n\n");
      const res = await model.generate({ system: prompt.text, user, schema: PickSchema, timeout_ms: opts.timeout_ms ?? 8_000 });
      return res.data;
    }
    const first = Math.max(0, Math.min(...candidate_start_ids) - 2);
    const shown = sentences.filter((s) => s.id >= first && s.id <= end_id);
    const lines = shown.map((s) => {
      const marks: string[] = [];
      if (candidate_start_ids.includes(s.id)) marks.push(s.id === snap_start_id ? "CANDIDATE, DEFAULT" : "CANDIDATE");
      if (s.id === end_id) marks.push("END");
      return `[${s.id}]${marks.length ? ` (${marks.join("; ")})` : ""} ${(s.start_ms / 1000).toFixed(1)}s ${s.speaker ?? "-"}: ${s.text}`;
    });
    const rule = short_exception
      ? "This window is shorter than the usual minimum; any offered candidate is acceptable."
      : `Every offered candidate already satisfies the ${Math.round(prefs.min_ms / 1000)} to ${Math.round(prefs.max_ms / 1000)} second length rule.`;
    const user = [`Candidate start ids: ${candidate_start_ids.join(", ")}. Default: ${snap_start_id}. End: ${end_id}.`, rule, delimited("transcript", lines.join("\n"))].join("\n\n");
    const res = await model.generate({ system: prompt.text, user, schema: PickSchema, timeout_ms: opts.timeout_ms ?? 8_000 });
    return res.data;
  };
  return Object.assign(pick, { prompt_version: prompt.version, ...(reach_ms !== undefined ? { reach_ms } : {}) });
}
