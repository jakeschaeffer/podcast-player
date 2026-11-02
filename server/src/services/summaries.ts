import type { AppContext } from "../app/context.js";
import { summarizeEpisode } from "../core/summary/episode.js";
import { readRegistry } from "../core/summary/prompts.js";
import type { EpisodeRow, FeedRow } from "../db/rows.js";
import { DeferJob, NonRetryable } from "../jobs/errors.js";
import type { Job } from "../jobs/queue.js";
import { newId } from "../lib/ids.js";
import { htmlToText } from "../lib/sanitize.js";
import { getAssetRow } from "./episodes.js";
import { loadTranscript } from "./transcripts.js";
import { queueAdDetection } from "./adBreaks.js";

/** Job body: produce the episode preview, takeaways, and chapters for an asset's current transcript. */
export async function summarizeEpisodeJob(ctx: AppContext, job: Job<{ asset_id: string }>): Promise<void> {
  const asset = getAssetRow(ctx, job.payload.asset_id);
  if (!asset.transcript_id) throw new DeferJob("no transcript yet");
  if (!ctx.textModel) throw new DeferJob("no text model configured (set TEXT_MODEL=codex-cli)");
  const existing = asset.summary_id
    ? (ctx.db.prepare("SELECT prompt_version FROM episode_summary WHERE id = ?").get(asset.summary_id) as { prompt_version: string } | undefined)
    : undefined;
  if (existing?.prompt_version === readRegistry()["episode-summary"].active) return;

  const transcript = loadTranscript(ctx, asset.transcript_id);
  const episode = ctx.db.prepare("SELECT * FROM episode WHERE id = ?").get(asset.episode_id) as EpisodeRow;
  const feed = ctx.db.prepare("SELECT * FROM feed WHERE id = ?").get(episode.feed_id) as FeedRow;
  const started = ctx.now();
  const result = await summarizeEpisode(
    { transcript, duration_ms: asset.duration_ms, metadata: { show_title: feed.title ?? "", episode_title: episode.title, description_text: htmlToText(episode.description_html), language: transcript.language } },
    ctx.textModel,
  );
  if (!result.ok) throw new NonRetryable(`episode summary rejected after ${result.attempts} attempts: ${result.problems.join("; ")}`);
  const id = newId();
  ctx.db.transaction(() => {
    ctx.db
      .prepare("INSERT INTO episode_summary (id, transcript_id, model, prompt_version, preview, takeaways, chapters, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, asset.transcript_id, result.model, result.prompt_version, result.preview, JSON.stringify(result.takeaways), JSON.stringify(result.chapters), ctx.now());
    ctx.db.prepare("UPDATE audio_asset SET summary_id = ? WHERE id = ?").run(id, asset.id);
  })();
  queueAdDetection(ctx, asset.id); // its ad chapters confirm or supply breaks
  ctx.log("episode summary stored", { asset_id: asset.id, summary_id: id, chapters: result.chapters.length, mode: result.mode, repairs: result.repairs.length, elapsed_ms: ctx.now() - started });
}
