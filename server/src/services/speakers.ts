/**
 * Who a transcript's voices are, worked out once per transcript by the `identify_speakers` job and stored with it.
 * New transcripts are queued when stored; older ones the first time their transcript is opened. The shared pages, the
 * apps' transcripts and snip summaries read the result; until it exists, voices are "Speaker 1", "Speaker 2".
 */
import type { AppContext } from "../app/context.js";
import { identifySpeakers, speakerSamples, type SpeakerIdentity } from "../core/speakers/identify.js";
import type { EpisodeRow, FeedRow } from "../db/rows.js";
import { DeferJob, NonRetryable } from "../jobs/errors.js";
import { PRIORITY, type Job } from "../jobs/queue.js";
import { htmlToText } from "../lib/sanitize.js";
import { getTranscriptRow, loadTranscript } from "./transcripts.js";

/** The stored identities, or null when the job has not run (or the transcript has no speaker labels). */
export function speakersFor(ctx: AppContext, transcriptId: string): SpeakerIdentity[] | null {
  const raw = ctx.db.prepare("SELECT speakers FROM transcript WHERE id = ?").pluck().get(transcriptId) as string | null | undefined;
  return raw ? (JSON.parse(raw) as { speakers: SpeakerIdentity[] }).speakers : null;
}

/** Label → name for the labels the publisher names, as the snip summary's `speaker_names` wants them. */
export function speakerNames(ctx: AppContext, transcriptId: string): Record<string, string> {
  return Object.fromEntries((speakersFor(ctx, transcriptId) ?? []).flatMap((s) => (s.name ? [[s.label, s.name]] : [])));
}

/** Queue identification for a transcript that has none yet; a no-op once it has run or is queued. */
export function queueSpeakers(ctx: AppContext, transcriptId: string, priority: number = PRIORITY.catalog): void {
  if (!ctx.textModel) return;
  const row = ctx.db.prepare("SELECT speakers FROM transcript WHERE id = ?").get(transcriptId) as { speakers: string | null } | undefined;
  if (!row || row.speakers) return;
  ctx.queue.enqueue("identify_speakers", `identify_speakers:${transcriptId}`, { transcript_id: transcriptId }, { priority });
}

/** Job body: identify the speakers of one transcript and store the answer with it. */
export async function identifySpeakersJob(ctx: AppContext, job: Job<{ transcript_id: string }>): Promise<void> {
  const row = getTranscriptRow(ctx, job.payload.transcript_id);
  if (row.speakers) return;
  if (!ctx.textModel) throw new DeferJob("no text model configured (set TEXT_MODEL=codex-cli)");
  const transcript = loadTranscript(ctx, row.id);
  const labels = speakerSamples(transcript);
  if (labels.length === 0) return; // no speaker labels: nothing to name
  const episode = ctx.db.prepare("SELECT e.* FROM episode e JOIN audio_asset a ON a.episode_id = e.id WHERE a.id = ?").get(row.audio_asset_id) as EpisodeRow;
  const feed = ctx.db.prepare("SELECT * FROM feed WHERE id = ?").get(episode.feed_id) as FeedRow;
  const result = await identifySpeakers(
    { show_title: feed.title ?? "", author: feed.author, episode_title: episode.title, description_text: htmlToText(episode.description_html), labels },
    ctx.textModel,
  );
  if (!result.ok && result.transport_error) throw new Error(result.problems.join("; "));
  if (!result.ok) throw new NonRetryable(`speakers rejected after ${result.attempts} attempts: ${result.problems.join("; ")}`);
  ctx.db
    .prepare("UPDATE transcript SET speakers = ? WHERE id = ?")
    .run(JSON.stringify({ speakers: result.speakers, model: result.model, prompt_version: result.prompt_version }), row.id);
  ctx.log("speakers identified", { transcript_id: row.id, speakers: result.speakers.map((s) => `${s.label}=${s.role}${s.name ? `:${s.name}` : ""}`) });
}
