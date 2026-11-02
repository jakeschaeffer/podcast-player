import { Type } from "@sinclair/typebox";
import { delimited, type TextModel } from "../adapters/textModel.js";
import type { SpanPicker } from "../core/snip/select.js";
import { resolvePrompt } from "../core/summary/prompts.js";

const PickSchema = Type.Object({ start_id: Type.Integer(), reason: Type.String({ maxLength: 300 }) }, { additionalProperties: false });

/**
 * The model moves the start among offered candidates; the selector validates the pick. The prompt version is fixed when
 * the picker is made (the active one unless `version` names another) and exposed so selections can record it.
 */
export function makeSpanPicker(model: TextModel, opts: { timeout_ms?: number; version?: string } = {}): SpanPicker & { prompt_version: string } {
  const prompt = resolvePrompt("span-picker", opts.version);
  const pick: SpanPicker = async ({ sentences, end_id, snap_start_id, candidate_start_ids, prefs, short_exception }) => {
    if (candidate_start_ids.length <= 1) return candidate_start_ids.length === 1 ? { start_id: candidate_start_ids[0]!, reason: "only candidate" } : null;
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
  return Object.assign(pick, { prompt_version: prompt.version });
}
