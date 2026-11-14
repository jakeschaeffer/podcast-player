import { appendFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Type } from "@sinclair/typebox";
import { delimited, type TextModel } from "../../adapters/textModel.js";
import type { SpanPicker } from "../../core/snip/select.js";
import { WIDE_REACH_MS } from "../../core/snip/select.js";
import { sentencize } from "../../core/snip/sentencize.js";
import type { NormalizedTranscript } from "../../core/transcript/types.js";

/**
 * An experiment (November 14, 2026): one model pass over a whole transcript, made once after transcription, that
 * marks where every thought begins. A snip's start then becomes a lookup at the tap instead of a model call the tap
 * has to wait for. Starts are kept as word indices, the transcript's own coordinates, so a map outlives any one
 * sentence numbering. Nothing in production reads a map yet; the selection eval scores what a selector could do
 * with one (`mapPicker`).
 */
export type EpisodeMap = { starts: { word: number; ms: number; title: string; major: boolean; needs_start?: boolean }[] };

export const MAP_PROMPT_VERSION = "v1";

const MapSchema = Type.Object(
  { thoughts: Type.Array(Type.Object({ start_id: Type.Integer(), title: Type.String({ maxLength: 120 }), major: Type.Boolean() }, { additionalProperties: false })) },
  { additionalProperties: false },
);

/** From v3 each passage also says whether a listener must hear it from its start (`needs_start`). */
const MapSchemaV3 = Type.Object(
  { thoughts: Type.Array(Type.Object({ start_id: Type.Integer(), title: Type.String({ maxLength: 120 }), major: Type.Boolean(), needs_start: Type.Boolean() }, { additionalProperties: false })) },
  { additionalProperties: false },
);

function withFlags(version: string): boolean {
  return version === "v3";
}

function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** One call: the whole episode in, the starts of its thoughts out. Ids the transcript doesn't have are dropped. */
export async function buildEpisodeMap(model: TextModel, prompt: string, t: NormalizedTranscript, timeout_ms: number, version = MAP_PROMPT_VERSION): Promise<{ map: EpisodeMap; elapsed_ms: number; sentences: number }> {
  const sentences = sentencize(t);
  const lines = sentences.map((s) => `[${s.id}] ${clock(s.start_ms)} ${s.speaker ?? "-"}: ${s.text}`);
  const res = await model.generate({ system: prompt, user: delimited("transcript", lines.join("\n")), schema: withFlags(version) ? MapSchemaV3 : MapSchema, timeout_ms });
  const seen = new Set<number>();
  const starts = res.data.thoughts
    .filter((x) => x.start_id >= 0 && x.start_id < sentences.length && !seen.has(x.start_id) && seen.add(x.start_id))
    .sort((a, b) => a.start_id - b.start_id)
    .map((x) => ({ word: sentences[x.start_id]!.start_word, ms: sentences[x.start_id]!.start_ms, title: x.title.trim(), major: x.major, ...("needs_start" in x ? { needs_start: Boolean(x.needs_start) } : {}) }));
  return { map: { starts }, elapsed_ms: res.elapsed_ms, sentences: sentences.length };
}

/** Maps already made, by transcript and prompt version, so a rerun of the scoring costs no model calls. */
export async function readMapCache(path: string): Promise<Map<string, EpisodeMap>> {
  const out = new Map<string, EpisodeMap>();
  if (!existsSync(path)) return out;
  for (const line of (await readFile(path, "utf8")).split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as { key: string; map: EpisodeMap };
    out.set(row.key, row.map);
  }
  return out;
}

export async function writeMapCache(path: string, key: string, map: EpisodeMap, meta: Record<string, unknown>): Promise<void> {
  await appendFile(path, `${JSON.stringify({ key, ...meta, map })}\n`);
}

/** The `passage` rule: what was playing this long before the tap counts as what was heard, and the clip is at least this long. */
export const PASSAGE_EPS_MS = 10_000;
export const PASSAGE_MIN_MS = 30_000;

export type MapRule = "passage" | "nearest-default" | "latest" | "second-latest" | "latest-major" | "ceiling";

/**
 * A start picker that needs no model at the tap: of the starts the selector offers (every sentence in the wide
 * reach), it considers only those the map marks as the beginning of a thought, and takes one by rule.
 *
 * - `passage`: the start of the passage that was playing 10 s before the tap, or of the one before it when that leaves
 *   under 30 s. A tap often comes just as a new passage begins, and then means the one that just ended. With the v3
 *   map this is the best rule found (November 14, 2026; evals/snip-selection/README.md).
 * - `nearest-default`: the marked start closest to where the rules would have started. Keeps the usual length, moved
 *   to the nearest beginning of a thought.
 * - `latest`: the last marked start before the end, the thought the tap interrupted or just finished.
 * - `second-latest`: one thought further back.
 * - `latest-major`: the last start the map marks as a change of topic.
 * - `ceiling`: knows the label, and takes a marked start inside the acceptable range when there is one. The most any
 *   rule could score with this map.
 *
 * With no marked start on offer it declines, and the rules' span stands.
 */
export function mapPicker(map: EpisodeMap, rule: MapRule, acceptable?: { from: number; to: number; ideal: number }): SpanPicker {
  const marked = new Set(map.starts.filter((s) => rule !== "latest-major" || s.major).map((s) => s.word));
  const pick: SpanPicker = async ({ sentences, candidate_start_ids, snap_start_id, anchor_ms }) => {
    // The selector numbers the sentences of its own window; a marked start is matched by where its first word is.
    const offered = candidate_start_ids.filter((id) => marked.has(sentences[id]!.start_word)).sort((a, b) => a - b);
    if (offered.length === 0) return null;
    const at = (id: number) => sentences[id]!.start_ms;
    let chosen: number | undefined;
    if (rule === "passage") {
      const before = offered.filter((id) => at(id) <= anchor_ms - PASSAGE_EPS_MS);
      chosen = [...before].reverse().find((id) => anchor_ms - at(id) >= PASSAGE_MIN_MS) ?? before[0];
    } else if (rule === "latest" || rule === "latest-major") chosen = offered[offered.length - 1];
    else if (rule === "second-latest") chosen = offered[offered.length - 2] ?? offered[offered.length - 1];
    else if (rule === "nearest-default") chosen = offered.reduce((a, b) => (Math.abs(at(a) - at(snap_start_id)) <= Math.abs(at(b) - at(snap_start_id)) ? a : b));
    else {
      const ok = offered.filter((id) => at(id) >= acceptable!.from && at(id) <= acceptable!.to);
      if (ok.length === 0) return null;
      chosen = ok.reduce((a, b) => (Math.abs(at(a) - acceptable!.ideal) <= Math.abs(at(b) - acceptable!.ideal) ? a : b));
    }
    return chosen === undefined ? null : { start_id: chosen, reason: `map ${rule}` };
  };
  return Object.assign(pick, { reach_ms: WIDE_REACH_MS });
}
