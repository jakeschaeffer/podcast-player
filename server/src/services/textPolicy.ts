import type { AppContext } from "../app/context.js";
import type { AudioAssetRow } from "../db/rows.js";

/**
 * Which transcript an asset should expose as current: the publisher-text one for episode kinds in
 * `textPreferredKinds` (Updates and Articles by default, where the text is verbatim and cleaner), the ASR one
 * otherwise (Interviews, where the published text is edited). Called whenever either kind of transcript lands.
 */
export function preferredTranscriptId(ctx: AppContext, assetId: string): string | null {
  const text = ctx.db
    .prepare(
      `SELECT t.id, x.kind FROM transcript t LEFT JOIN episode_text x ON x.id = t.text_id
       WHERE t.audio_asset_id = ? AND t.source != 'asr' ORDER BY t.created_at DESC LIMIT 1`,
    )
    .get(assetId) as { id: string; kind: string | null } | undefined;
  const asr = ctx.db.prepare("SELECT id FROM transcript WHERE audio_asset_id = ? AND source = 'asr' ORDER BY created_at DESC LIMIT 1").get(assetId) as { id: string } | undefined;
  if (text && ctx.config.textPreferredKinds.has(text.kind ?? "other")) return text.id;
  return asr?.id ?? text?.id ?? null;
}

/** Point the asset at its preferred transcript. Returns true when the pointer changed. */
export function applyTextPolicyForAsset(ctx: AppContext, assetId: string): boolean {
  const asset = ctx.db.prepare("SELECT id, transcript_id FROM audio_asset WHERE id = ?").get(assetId) as Pick<AudioAssetRow, "id" | "transcript_id"> | undefined;
  if (!asset) return false;
  const want = preferredTranscriptId(ctx, assetId);
  if (!want || want === asset.transcript_id) return false;
  ctx.db.prepare("UPDATE audio_asset SET transcript_id = ? WHERE id = ?").run(want, assetId);
  return true;
}

/** Apply the policy to every asset; used once after the policy or the preferred kinds change. */
export function applyTextPolicy(ctx: AppContext): { assets: number; changed: number; now_text: number; now_asr: number } {
  const ids = ctx.db.prepare("SELECT id FROM audio_asset WHERE transcript_id IS NOT NULL").pluck().all() as string[];
  let changed = 0;
  for (const id of ids) if (applyTextPolicyForAsset(ctx, id)) changed++;
  const counts = ctx.db
    .prepare("SELECT t.source, COUNT(*) AS n FROM audio_asset a JOIN transcript t ON t.id = a.transcript_id GROUP BY t.source")
    .all() as { source: string; n: number }[];
  return { assets: ids.length, changed, now_text: counts.filter((c) => c.source !== "asr").reduce((x, c) => x + c.n, 0), now_asr: counts.find((c) => c.source === "asr")?.n ?? 0 };
}
