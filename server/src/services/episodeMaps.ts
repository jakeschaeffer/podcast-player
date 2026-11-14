import { Type } from "@sinclair/typebox";
import type { AppContext } from "../app/context.js";
import { delimited, type TextModel } from "../adapters/textModel.js";
import type { EpisodeMap } from "../core/snip/episodeMap.js";
import { sentencize } from "../core/snip/sentencize.js";
import { readRegistry, resolvePrompt } from "../core/summary/prompts.js";
import type { NormalizedTranscript } from "../core/transcript/types.js";
import { PRIORITY, type Job } from "../jobs/queue.js";
import { loadTranscript } from "./transcripts.js";

/**
 * Episode maps (core/snip/episodeMap.ts) in production: one model call per transcript, made when an episode is
 * played with a transcript, or when a transcript arrives for an episode that has been played or snipped. Never for
 * the rest of the catalog, so the cost follows listening: about one call an episode heard.
 */

const MapSchema = Type.Object(
  { thoughts: Type.Array(Type.Object({ start_id: Type.Integer(), title: Type.String({ maxLength: 120 }), major: Type.Boolean() }, { additionalProperties: false })) },
  { additionalProperties: false },
);

/** v3 also asks of each passage whether it must be heard from its start (`needs_start`); the rule doesn't use it. */
const MapSchemaV3 = Type.Object(
  { thoughts: Type.Array(Type.Object({ start_id: Type.Integer(), title: Type.String({ maxLength: 120 }), major: Type.Boolean(), needs_start: Type.Boolean() }, { additionalProperties: false })) },
  { additionalProperties: false },
);

const schemaFor = (version: string) => (version === "v3" ? MapSchemaV3 : MapSchema);

/** A whole episode is one call of a minute or two; a long one at a busy moment can take several. */
export const MAP_TIMEOUT_MS = 600_000;

function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** One call: the whole episode in, the starts of its passages out. Ids the transcript doesn't have are dropped. */
export async function buildEpisodeMap(
  model: TextModel,
  prompt: { version: string; text: string },
  t: NormalizedTranscript,
  timeout_ms = MAP_TIMEOUT_MS,
): Promise<{ map: EpisodeMap; model: string; elapsed_ms: number; sentences: number }> {
  const sentences = sentencize(t);
  const lines = sentences.map((s) => `[${s.id}] ${clock(s.start_ms)} ${s.speaker ?? "-"}: ${s.text}`);
  const res = await model.generate({ system: prompt.text, user: delimited("transcript", lines.join("\n")), schema: schemaFor(prompt.version), timeout_ms });
  const seen = new Set<number>();
  const starts = res.data.thoughts
    .filter((x) => x.start_id >= 0 && x.start_id < sentences.length && !seen.has(x.start_id) && seen.add(x.start_id))
    .sort((a, b) => a.start_id - b.start_id)
    .map((x) => ({
      word: sentences[x.start_id]!.start_word, ms: sentences[x.start_id]!.start_ms, title: x.title.trim().slice(0, 120), major: x.major,
      ...("needs_start" in x ? { needs_start: Boolean(x.needs_start) } : {}),
    }));
  return { map: { starts }, model: res.model, elapsed_ms: res.elapsed_ms, sentences: sentences.length };
}

/** The map of a transcript made with the active prompt version, if there is one. */
export function loadEpisodeMap(ctx: AppContext, transcriptId: string): { map: EpisodeMap; prompt_version: string } | null {
  const version = readRegistry()["episode-map"].active;
  const row = ctx.db.prepare("SELECT starts FROM episode_map WHERE transcript_id = ? AND prompt_version = ?").get(transcriptId, version) as { starts: string } | undefined;
  return row ? { map: { starts: JSON.parse(row.starts) as EpisodeMap["starts"] }, prompt_version: version } : null;
}

/**
 * Ask for a transcript's map once. A job that already exists, whatever became of it, is left alone: playback reports
 * call this every few seconds, and a map that failed is not worth retrying on each of them.
 */
export function queueEpisodeMap(ctx: AppContext, transcriptId: string, priority: number = PRIORITY.play): void {
  if (!ctx.textModel || !ctx.config.episodeMaps) return;
  const version = readRegistry()["episode-map"].active;
  const key = `map_episode:${transcriptId}:${version}`;
  if (ctx.db.prepare("SELECT 1 FROM episode_map WHERE transcript_id = ? AND prompt_version = ?").get(transcriptId, version)) return;
  if (ctx.db.prepare("SELECT 1 FROM job WHERE key = ?").get(key)) return;
  ctx.queue.enqueue("map_episode", key, { transcript_id: transcriptId, version }, { priority });
}

/** Job body: make and keep the map. */
export async function mapEpisodeJob(ctx: AppContext, job: Job<{ transcript_id: string; version: string }>): Promise<void> {
  if (!ctx.textModel) return;
  const { transcript_id, version } = job.payload;
  if (ctx.db.prepare("SELECT 1 FROM episode_map WHERE transcript_id = ? AND prompt_version = ?").get(transcript_id, version)) return;
  const t = loadTranscript(ctx, transcript_id);
  if (!t) return;
  const built = await buildEpisodeMap(ctx.textModel, resolvePrompt("episode-map", version), t);
  ctx.db
    .prepare("INSERT OR REPLACE INTO episode_map (transcript_id, prompt_version, model, starts, elapsed_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(transcript_id, version, built.model, JSON.stringify(built.map.starts), Math.round(built.elapsed_ms), ctx.now());
  ctx.log("episode mapped", { transcript_id, version, sentences: built.sentences, passages: built.map.starts.length, elapsed_ms: Math.round(built.elapsed_ms) });
}
