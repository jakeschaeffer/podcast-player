import { unlink } from "node:fs/promises";
import type { AppContext } from "../app/context.js";

/** A Short as stored: the channel feed linked it as `/shorts/{id}` (core/feed/youtube.ts). */
const SHORT = "e.media_kind = 'video' AND e.youtube_id IS NOT NULL AND e.link LIKE 'https://www.youtube.com/shorts/%'";

/**
 * Remove every YouTube Short from the library, played or not: the episode and everything under it (recording and its
 * files, transcript, summaries, maps, ad breaks, playback, Up Next, share link, pending jobs). Channel refreshes have
 * skipped Shorts since PR #71; this clears those that came in before. A Short with a snip, even a deleted one, is kept
 * (deleting a snip unpublishes its link and removes it from Readwise, which is its own decision); the log says so.
 */
export async function removeYouTubeShorts(ctx: AppContext): Promise<{ removed: number; kept_for_snips: number }> {
  const kept = ctx.db
    .prepare(`SELECT COUNT(DISTINCT e.id) FROM episode e JOIN audio_asset a ON a.episode_id = e.id JOIN snip s ON s.audio_asset_id = a.id WHERE ${SHORT}`)
    .pluck()
    .get() as number;
  const episodes = ctx.db
    .prepare(`SELECT e.id FROM episode e WHERE ${SHORT} AND NOT EXISTS (SELECT 1 FROM audio_asset a JOIN snip s ON s.audio_asset_id = a.id WHERE a.episode_id = e.id)`)
    .pluck()
    .all() as string[];
  if (episodes.length === 0) {
    if (kept > 0) ctx.log("youtube shorts kept for their snips", { kept });
    return { removed: 0, kept_for_snips: kept };
  }
  const files = new Set<string>();
  ctx.db.transaction(() => {
    ctx.db.exec("CREATE TEMP TABLE IF NOT EXISTS gone_episode (id TEXT PRIMARY KEY); CREATE TEMP TABLE IF NOT EXISTS gone_asset (id TEXT PRIMARY KEY); CREATE TEMP TABLE IF NOT EXISTS gone_transcript (id TEXT PRIMARY KEY); DELETE FROM gone_episode; DELETE FROM gone_asset; DELETE FROM gone_transcript;");
    const addEpisode = ctx.db.prepare("INSERT INTO gone_episode (id) VALUES (?)");
    for (const id of episodes) addEpisode.run(id);
    ctx.db.exec("INSERT INTO gone_asset SELECT id FROM audio_asset WHERE episode_id IN (SELECT id FROM gone_episode)");
    ctx.db.exec("INSERT INTO gone_transcript SELECT id FROM transcript WHERE audio_asset_id IN (SELECT id FROM gone_asset)");
    for (const r of ctx.db.prepare("SELECT path, video_path FROM audio_asset WHERE id IN (SELECT id FROM gone_asset)").all() as { path: string | null; video_path: string | null }[]) {
      if (r.path) files.add(r.path);
      if (r.video_path) files.add(r.video_path);
    }
    ctx.db.exec(`
      DELETE FROM job WHERE status != 'running' AND substr(key, instr(key, ':') + 1) IN (SELECT id FROM gone_episode UNION SELECT id FROM gone_asset UNION SELECT id FROM gone_transcript);
      DELETE FROM playback_state WHERE audio_asset_id IN (SELECT id FROM gone_asset);
      DELETE FROM ad_detection WHERE audio_asset_id IN (SELECT id FROM gone_asset);
      UPDATE audio_asset SET transcript_id = NULL, summary_id = NULL WHERE id IN (SELECT id FROM gone_asset);
      DELETE FROM episode_summary WHERE transcript_id IN (SELECT id FROM gone_transcript);
      DELETE FROM episode_map WHERE transcript_id IN (SELECT id FROM gone_transcript);
      DELETE FROM transcript_segment WHERE transcript_id IN (SELECT id FROM gone_transcript);
      DELETE FROM transcript WHERE id IN (SELECT id FROM gone_transcript);
      UPDATE episode SET current_asset_id = NULL WHERE id IN (SELECT id FROM gone_episode);
      DELETE FROM audio_asset WHERE id IN (SELECT id FROM gone_asset);
      DELETE FROM episode_text WHERE episode_id IN (SELECT id FROM gone_episode);
      DELETE FROM episode_share WHERE episode_id IN (SELECT id FROM gone_episode);
      DELETE FROM up_next WHERE episode_id IN (SELECT id FROM gone_episode);
      DELETE FROM episode WHERE id IN (SELECT id FROM gone_episode);
    `);
  })();
  const stillUsed = ctx.db.prepare("SELECT 1 FROM audio_asset WHERE path = ? OR video_path = ? LIMIT 1");
  for (const f of files) if (!stillUsed.get(f, f)) await unlink(f).catch(() => undefined);
  ctx.log("youtube shorts removed", { removed: episodes.length, files: files.size, kept_for_snips: kept });
  return { removed: episodes.length, kept_for_snips: kept };
}
