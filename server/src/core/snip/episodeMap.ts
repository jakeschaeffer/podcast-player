import { WIDE_REACH_MS, type SpanPicker } from "./select.js";

/**
 * An episode map: where each passage of a transcript begins, made once by one model call over the whole transcript
 * (services/episodeMaps.ts, prompt `episode-map`). A snip's start is then a lookup at the tap, not a model call the
 * tap waits for. Starts are word indices into the map's own transcript, so they outlive any sentence numbering.
 *
 * Measured November 14, 2026 (evals/snip-selection/README.md): with the v3 prompt and the `passage` rule, 21 of the
 * 48 snips made in the app needed no edit against 4 for the 90 s default, judged by the owner's 17 edits and by blind
 * judges for the snips the owner never looked at; on 24 held-out taps, 14 against 4.
 */
export type EpisodeMap = { starts: { word: number; ms: number; title: string; major: boolean; needs_start?: boolean }[] };

/** The `passage` rule: what was playing this long before the tap counts as what was heard, and the clip is at least this long. */
export const PASSAGE_EPS_MS = 10_000;
export const PASSAGE_MIN_MS = 30_000;

export type MapRule = "passage" | "nearest-default" | "latest" | "second-latest" | "latest-major" | "ceiling";

/**
 * A start picker that needs no model at the tap: of the starts the selector offers (every sentence in the wide
 * reach), it considers only those the map marks as a passage start, and takes one by rule.
 *
 * - `passage` (production): the start of the passage that was playing 10 s before the tap, or of the one before it
 *   when that leaves under 30 s. A tap often comes just as a new passage begins, and then means the one that just
 *   ended. A passage that began beyond the reach declines, and the rules' span stands.
 * - `nearest-default`: the marked start closest to where the rules would have started.
 * - `latest`: the last marked start before the end.
 * - `second-latest`: one further back.
 * - `latest-major`: the last start the map marks as a change of topic.
 * - `ceiling` (evals only): knows the label, and takes a marked start inside the acceptable range when there is one.
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
      if (!acceptable) return null;
      const ok = offered.filter((id) => at(id) >= acceptable.from && at(id) <= acceptable.to);
      if (ok.length === 0) return null;
      chosen = ok.reduce((a, b) => (Math.abs(at(a) - acceptable.ideal) <= Math.abs(at(b) - acceptable.ideal) ? a : b));
    }
    return chosen === undefined ? null : { start_id: chosen, reason: `map ${rule}` };
  };
  return Object.assign(pick, { reach_ms: WIDE_REACH_MS });
}

/** The passage that begins at a word, for its title. */
export function passageAt(map: EpisodeMap, word: number | null): EpisodeMap["starts"][number] | null {
  return word === null ? null : (map.starts.find((s) => s.word === word) ?? null);
}
