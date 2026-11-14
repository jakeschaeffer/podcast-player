import { identifySpeakersJob } from "../services/speakers.js";
import type { AppContext } from "../app/context.js";
import { HttpError } from "../app/errors.js";
import { fetchAudioJob } from "../services/episodes.js";
import { syncEmailJob } from "../services/emailSource.js";
import { refreshFeedJob, scheduledFeedIds } from "../services/feeds.js";
import { alignTextJob } from "../services/publisherText.js";
import { detectAdsJob } from "../services/adBreaks.js";
import { pruneOldClips, queueMissingVideoClips, renderClipJob, renderVideoClipJob, revisionGaveUp, selectSnipJob, summarizeSnipGaveUp, summarizeSnipJob } from "../services/snipJobs.js";
import { evalRunJob } from "../services/evalRuns.js";
import { mapEpisodeJob } from "../services/episodeMaps.js";
import { queueReadwiseSweep, syncReadwiseJob } from "../services/readwiseSync.js";
import { summarizeEpisodeJob } from "../services/summaries.js";
import { transcribeJob } from "../services/transcripts.js";
import { DeferJob, NonRetryable } from "./errors.js";
import type { Job, JobKind } from "./queue.js";
import { fetchVideoJob, pruneVideoJob, pruneVideosToCap } from "../services/video.js";

type Handler = (ctx: AppContext, job: Job<never>) => Promise<unknown>;

/** One handler per job kind. Handlers are plain async functions over the context; nothing else is registered anywhere. */
export const handlers: Record<JobKind, Handler> = {
  refresh_feed: (ctx, job) => refreshFeedJob(ctx, job as Job<{ feed_id: string }>),
  fetch_audio: (ctx, job) => fetchAudioJob(ctx, job as Job<{ episode_id: string }>),
  fetch_video: (ctx, job) => fetchVideoJob(ctx, job as Job<{ episode_id: string }>),
  prune_video: (ctx, job) => pruneVideoJob(ctx, job as Job<{ asset_id: string }>),
  transcribe: (ctx, job) => transcribeJob(ctx, job as Job<{ asset_id: string }>),
  summarize_episode: (ctx, job) => summarizeEpisodeJob(ctx, job as Job<{ asset_id: string }>),
  select_snip: (ctx, job) => selectSnipJob(ctx, job as Job<{ revision_id: string }>),
  render_clip: (ctx, job) => renderClipJob(ctx, job as Job<{ revision_id: string }>),
  render_video_clip: (ctx, job) => renderVideoClipJob(ctx, job as Job<{ revision_id: string }>),
  summarize_snip: (ctx, job) => summarizeSnipJob(ctx, job as Job<{ revision_id: string }>),
  sync_email: (ctx, job) => syncEmailJob(ctx, job),
  align_text: (ctx, job) => alignTextJob(ctx, job as Job<{ text_id: string }>),
  detect_ads: (ctx, job) => detectAdsJob(ctx, job as Job<{ asset_id: string }>),
  eval_run: (ctx, job) => evalRunJob(ctx, job as Job<{ eval: "titles" | "selection"; version: string; stamp: string }>),
  identify_speakers: (ctx, job) => identifySpeakersJob(ctx, job as Job<{ transcript_id: string }>),
  sync_readwise: (ctx, job) => syncReadwiseJob(ctx, job as Job<{ snip_id: string }>),
  map_episode: (ctx, job) => mapEpisodeJob(ctx, job as Job<{ transcript_id: string; version: string }>),
};

/**
 * What to record when a job of this kind fails for good (retries used up, or a permanent error), so the thing it was
 * working on does not sit in a "preparing" state forever. Kinds without an entry just stay visible as failed jobs.
 */
export const onGaveUp: Partial<Record<JobKind, (ctx: AppContext, job: Job<never>, error: string) => void>> = {
  select_snip: (ctx, job, error) => revisionGaveUp(ctx, job as Job<{ revision_id: string }>, error),
  render_clip: (ctx, job, error) => revisionGaveUp(ctx, job as Job<{ revision_id: string }>, error),
  summarize_snip: (ctx, job, error) => summarizeSnipGaveUp(ctx, job as Job<{ revision_id: string }>, error),
};

/** How many jobs of each kind may run at once on this host. Network-bound kinds get two; CPU-bound kinds one. */
export const CONCURRENCY: Record<JobKind, number> = {
  refresh_feed: 2,
  fetch_audio: 1,
  fetch_video: 1,
  prune_video: 1,
  transcribe: 2,
  summarize_episode: 1,
  select_snip: 2,
  render_clip: 1,
  render_video_clip: 1,
  summarize_snip: 2,
  sync_email: 1,
  align_text: 2,
  // Aligning an interview against its article holds tens of megabytes for a few seconds; one at a time.
  detect_ads: 1,
  // Evals are dozens to hundreds of model calls; one at a time keeps them from crowding out snips.
  eval_run: 1,
  identify_speakers: 1,
  // One at a time keeps a backfill of every snip well inside Readwise's rate limit.
  sync_readwise: 1,
  // A whole episode in one model call: one at a time, so maps never crowd out snip titles.
  map_episode: 1,
};

export type JobOutcome = "done" | "deferred" | "retry" | "failed";

/** Run one claimed job to its outcome. Never throws. */
export async function runJob(ctx: AppContext, job: Job): Promise<JobOutcome> {
  const started = ctx.now();
  const heartbeat = setInterval(() => ctx.queue.heartbeat(job.id), 60_000);
  try {
    await handlers[job.kind](ctx, job as Job<never>);
    ctx.queue.complete(job.id);
    ctx.log("job done", { kind: job.kind, key: job.key, attempt: job.attempts, elapsed_ms: ctx.now() - started });
    return "done";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof DeferJob) {
      ctx.queue.defer(job.id, message);
      ctx.log("job deferred", { kind: job.kind, key: job.key, reason: message });
      return "deferred";
    }
    const permanent = err instanceof NonRetryable || (err instanceof HttpError && err.status < 500);
    ctx.queue.fail(job.id, message, { retryable: !permanent });
    const after = ctx.queue.get(job.id);
    const gaveUp = after?.status === "failed";
    ctx.log(gaveUp ? "job failed" : "job retry scheduled", { kind: job.kind, key: job.key, attempt: job.attempts, error: message });
    if (gaveUp) {
      try {
        onGaveUp[job.kind]?.(ctx, job as Job<never>, message);
      } catch (hookErr) {
        ctx.log("give-up handler failed", { kind: job.kind, key: job.key, error: String(hookErr) });
      }
    }
    return gaveUp ? "failed" : "retry";
  } finally {
    clearInterval(heartbeat);
  }
}

/** Run claimable jobs one at a time until none is left. For tests, the CLI, and cron-style catch-up. */
export async function drain(ctx: AppContext, opts: { kinds?: JobKind[]; max?: number } = {}): Promise<{ ran: number; outcomes: Record<JobOutcome, number> }> {
  const kinds = opts.kinds ?? (Object.keys(handlers) as JobKind[]);
  const outcomes: Record<JobOutcome, number> = { done: 0, deferred: 0, retry: 0, failed: 0 };
  let ran = 0;
  while (ran < (opts.max ?? 1000)) {
    const job = ctx.queue.claim(kinds);
    if (!job) break;
    outcomes[await runJob(ctx, job)]++;
    ran++;
  }
  return { ran, outcomes };
}

/**
 * The long-running worker loop: polls the queue, keeps per-kind concurrency, prunes old clips hourly, and queues any video clips and Readwise syncs still owed.
 * Resolve `stop()` to let in-flight jobs finish.
 */
export function startWorker(ctx: AppContext, opts: { pollMs?: number; concurrency?: Partial<Record<JobKind, number>> } = {}): { stop: () => Promise<void> } {
  const pollMs = opts.pollMs ?? 500;
  const limits = { ...CONCURRENCY, ...opts.concurrency };
  const running = new Map<JobKind, number>();
  const inFlight = new Set<Promise<unknown>>();
  let stopped = false;
  let lastPrune = 0;
  let lastRefresh = 0;
  const refreshEvery = ctx.config.refreshIntervalMinutes * 60_000;

  const tick = () => {
    if (stopped) return;
    const free = (Object.keys(handlers) as JobKind[]).filter((k) => (running.get(k) ?? 0) < limits[k]);
    const job = ctx.queue.claim(free);
    if (job) {
      running.set(job.kind, (running.get(job.kind) ?? 0) + 1);
      const p = runJob(ctx, job).finally(() => {
        running.set(job.kind, (running.get(job.kind) ?? 0) - 1);
        inFlight.delete(p);
      });
      inFlight.add(p);
      setImmediate(tick); // there may be more work right away
      return;
    }
    if (ctx.now() - lastPrune > 3_600_000) {
      lastPrune = ctx.now();
      void pruneOldClips(ctx).catch((err) => ctx.log("prune failed", { error: String(err) }));
      queueMissingVideoClips(ctx);
      queueReadwiseSweep(ctx);
      void pruneVideosToCap(ctx).catch((err) => ctx.log("video prune failed", { error: String(err) }));
    }
    if (refreshEvery > 0 && ctx.now() - lastRefresh > refreshEvery) {
      lastRefresh = ctx.now();
      const feeds = scheduledFeedIds(ctx);
      for (const feedId of feeds) ctx.queue.enqueue("refresh_feed", `refresh_feed:${feedId}`, { feed_id: feedId, scheduled: true }, { rerun: true });
      if (ctx.config.emailSourceQuery && process.env.GOOGLE_REFRESH_TOKEN) ctx.queue.enqueue("sync_email", "sync_email:all", { scheduled: true }, { rerun: true });
      if (feeds.length > 0) ctx.log("scheduled refresh queued", { feeds: feeds.length, every_minutes: ctx.config.refreshIntervalMinutes });
    }
  };
  const timer = setInterval(tick, pollMs);
  ctx.log("worker started", { pollMs, limits, refresh_every_minutes: ctx.config.refreshIntervalMinutes });
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await Promise.allSettled([...inFlight]);
      ctx.log("worker stopped");
    },
  };
}
