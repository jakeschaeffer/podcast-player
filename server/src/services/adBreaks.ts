import type { AppContext } from "../app/context.js";
import { AD_DETECTOR_VERSION, detectAds, type AdBreak } from "../core/ads/detect.js";
import type { AudioAssetRow, EpisodeSummaryRow } from "../db/rows.js";
import { PRIORITY, type Job } from "../jobs/queue.js";
import { getAssetRow } from "./episodes.js";
import { loadTranscript } from "./transcripts.js";

/**
 * Publisher text read word for word, where a long passage missing from it is an ad on its own. Interviews are edited
 * transcripts that drop passages (evals/transcription/README.md), so there a gap needs a sponsor phrase or ad chapter.
 */
const VERBATIM_KINDS = new Set(["update", "article"]);

type Inputs = { asr: string | null; publisher: string | null; summary: string | null };
type DetectionRow = { audio_asset_id: string; detector: string; inputs: string; breaks: string; created_at: number };

/** The ids detection reads for an asset: its newest ASR and publisher-text transcripts and its summary. */
function inputsFor(ctx: AppContext, asset: AudioAssetRow): Inputs & { kind: string | null } {
  const asr = ctx.db.prepare("SELECT id FROM transcript WHERE audio_asset_id = ? AND source = 'asr' ORDER BY created_at DESC LIMIT 1").pluck().get(asset.id) as string | undefined;
  const text = ctx.db
    .prepare("SELECT t.id, x.kind FROM transcript t LEFT JOIN episode_text x ON x.id = t.text_id WHERE t.audio_asset_id = ? AND t.source != 'asr' ORDER BY t.created_at DESC LIMIT 1")
    .get(asset.id) as { id: string; kind: string | null } | undefined;
  return { asr: asr ?? null, publisher: text?.id ?? null, summary: asset.summary_id, kind: text?.kind ?? null };
}

const sameInputs = (a: Inputs, b: Inputs) => a.asr === b.asr && a.publisher === b.publisher && a.summary === b.summary;

/** Queue (or re-queue) detection for an asset. Cheap and free: no provider is called. */
export function queueAdDetection(ctx: AppContext, assetId: string, priority: number = PRIORITY.catalog): void {
  ctx.queue.enqueue("detect_ads", `detect_ads:${assetId}`, { asset_id: assetId }, { priority, rerun: true });
}

/**
 * The asset's ad breaks. When none are stored yet, or they came from older inputs or an older detector, they are
 * computed and stored right here (tens of milliseconds for an Update, under a second for an interview with its
 * article): a client loads the episode once when playback starts, so a break found a moment later by a queued job
 * would get no button on the first listen. Should computing fail, the job is queued and what is stored is served.
 */
export function adBreaksFor(ctx: AppContext, asset: AudioAssetRow): AdBreak[] {
  const row = ctx.db.prepare("SELECT * FROM ad_detection WHERE audio_asset_id = ?").get(asset.id) as DetectionRow | undefined;
  const want = inputsFor(ctx, asset);
  if (!want.asr && !want.publisher && !want.summary) return [];
  if (row && row.detector === AD_DETECTOR_VERSION && sameInputs(JSON.parse(row.inputs) as Inputs, want)) return JSON.parse(row.breaks) as AdBreak[];
  try {
    const { inputs, breaks } = computeAdBreaks(ctx, asset);
    storeAdBreaks(ctx, asset.id, inputs, breaks);
    return breaks;
  } catch (err) {
    ctx.log("ad detection failed inline; queued", { asset_id: asset.id, error: err instanceof Error ? err.message : String(err) });
    queueAdDetection(ctx, asset.id, PRIORITY.play);
    return row ? (JSON.parse(row.breaks) as AdBreak[]) : [];
  }
}

/** Run the detector over an asset's current inputs without storing anything; the job and the CLI share it. */
export function computeAdBreaks(ctx: AppContext, asset: AudioAssetRow): { inputs: Inputs; breaks: AdBreak[] } {
  const { kind, ...inputs } = inputsFor(ctx, asset);
  const summary = inputs.summary ? (ctx.db.prepare("SELECT chapters FROM episode_summary WHERE id = ?").get(inputs.summary) as Pick<EpisodeSummaryRow, "chapters"> | undefined) : undefined;
  const breaks = detectAds({
    speech: inputs.asr ? loadTranscript(ctx, inputs.asr) : null,
    publisher: inputs.publisher ? { transcript: loadTranscript(ctx, inputs.publisher), verbatim: VERBATIM_KINDS.has(kind ?? "") } : null,
    chapters: summary ? (JSON.parse(summary.chapters) as { start_ms: number; end_ms: number; kind: string }[]) : null,
    duration_ms: asset.duration_ms,
  });
  return { inputs, breaks };
}

export function storeAdBreaks(ctx: AppContext, assetId: string, inputs: Inputs, breaks: AdBreak[]): void {
  ctx.db
    .prepare(
      `INSERT INTO ad_detection (audio_asset_id, detector, inputs, breaks, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (audio_asset_id) DO UPDATE SET detector = excluded.detector, inputs = excluded.inputs, breaks = excluded.breaks, created_at = excluded.created_at`,
    )
    .run(assetId, AD_DETECTOR_VERSION, JSON.stringify(inputs), JSON.stringify(breaks), ctx.now());
}

/** Job body: detect the ad breaks of an asset from its current transcripts and summary, and store them. */
export async function detectAdsJob(ctx: AppContext, job: Job<{ asset_id: string }>): Promise<void> {
  const asset = getAssetRow(ctx, job.payload.asset_id);
  const started = ctx.now();
  const { inputs, breaks } = computeAdBreaks(ctx, asset);
  storeAdBreaks(ctx, asset.id, inputs, breaks);
  ctx.log("ad breaks stored", { asset_id: asset.id, breaks: breaks.length, high: breaks.filter((b) => b.confidence === "high").length, elapsed_ms: ctx.now() - started });
}
