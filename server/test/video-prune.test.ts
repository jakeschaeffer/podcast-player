import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newId } from "../src/lib/ids.js";
import { reportPlayback } from "../src/services/playback.js";
import { PRUNE_AFTER_FINISHED_MS, pruneVideoJob, pruneVideosToCap } from "../src/services/video.js";
import { testContext } from "./helpers/context.js";

/**
 * Video files are dropped a day after the episode was finished, and the store is kept under its cap, least recently
 * played first. The audio stays either way: the asset row keeps its path, transcript and snips.
 */
describe("video pruning", () => {
  let now = 1_000_000_000_000;
  const ctx = testContext({ now: () => now, config: { videoStoreMaxBytes: 250 } });
  const feedId = newId();
  const device = newId();
  ctx.db.prepare("INSERT INTO feed (id, url_enc, url_hash, title, created_at) VALUES (?, ?, ?, 'Show', 0)").run(feedId, Buffer.from("x"), feedId);
  ctx.db.prepare("INSERT INTO device (id, name, platform, token_hash, created_at) VALUES (?, 'phone', 'ios', ?, 0)").run(device, device);
  mkdirSync(ctx.paths.assets, { recursive: true });

  /** An episode whose recording is a video of `bytes` bytes, fetched at `createdAt`. */
  const video = (title: string, bytes: number, createdAt: number) => {
    const episode = newId();
    const asset = newId();
    const path = join(ctx.paths.assets, `${asset}.mp4`);
    writeFileSync(path, Buffer.alloc(bytes));
    ctx.db.prepare("INSERT INTO episode (id, feed_id, guid, title, first_seen_at, enclosure_url_enc, media_kind, youtube_id) VALUES (?, ?, ?, ?, 0, ?, 'video', 'bJD1NpdMY5s')").run(episode, feedId, episode, title, Buffer.from("x"));
    ctx.db
      .prepare("INSERT INTO audio_asset (id, episode_id, sha256, bytes, duration_ms, mime, path, pinned, created_at, video_path, video_sha256, video_bytes, video_width, video_height) VALUES (?, ?, ?, 10, 600000, 'audio/mp4', '/audio', 0, ?, ?, ?, ?, 1280, 720)")
      .run(asset, episode, asset, createdAt, path, `sha-${asset}`, bytes);
    ctx.db.prepare("UPDATE episode SET current_asset_id = ? WHERE id = ?").run(asset, episode);
    return { asset, path };
  };
  const row = (asset: string) => ctx.db.prepare("SELECT video_path, video_bytes, path FROM audio_asset WHERE id = ?").get(asset) as { video_path: string | null; video_bytes: number | null; path: string };

  it("schedules a prune a day after a finished report, and drops the video then if it is still finished", async () => {
    const { asset, path } = video("Finished", 100, now - 3 * PRUNE_AFTER_FINISHED_MS);
    reportPlayback(ctx, device, asset, { position_ms: 600000, speed: 1, playing: false, finished: true, seq: 1 });
    const job = ctx.queue.byKey(`prune_video:${asset}`);
    expect(job?.status).toBe("queued");
    expect(job?.run_after).toBe(now + PRUNE_AFTER_FINISHED_MS);
    // Nothing is claimable until the day has passed.
    expect(ctx.queue.claim(["prune_video"])).toBeNull();
    now += PRUNE_AFTER_FINISHED_MS + 1;
    const claimed = ctx.queue.claim(["prune_video"]);
    expect(claimed?.key).toBe(`prune_video:${asset}`);
    await pruneVideoJob(ctx, claimed as never);
    expect(existsSync(path)).toBe(false);
    expect(row(asset)).toMatchObject({ video_path: null, video_bytes: null, path: "/audio" }); // the audio stays
  });

  it("keeps a video that was played again after it was finished", async () => {
    const { asset, path } = video("Replayed", 100, now - 3 * PRUNE_AFTER_FINISHED_MS);
    reportPlayback(ctx, device, asset, { position_ms: 600000, speed: 1, playing: false, finished: true, seq: 1 });
    reportPlayback(ctx, device, asset, { position_ms: 120000, speed: 1, playing: true, finished: false, seq: 2 });
    now += PRUNE_AFTER_FINISHED_MS + 1;
    await pruneVideoJob(ctx, ctx.queue.claim(["prune_video"]) as never);
    expect(existsSync(path)).toBe(true);
    expect(row(asset).video_path).toBe(path);
  });

  it("keeps the store under its cap, dropping the least recently played first and sparing the last day's fetches", async () => {
    const day = PRUNE_AFTER_FINISHED_MS;
    const old = video("Old, never played", 100, now - 10 * day);
    const played = video("Played last week", 100, now - 10 * day);
    ctx.db.prepare("UPDATE audio_asset SET video_last_played_at = ? WHERE id = ?").run(now - 7 * day, played.asset);
    const fresh = video("Fetched today", 100, now - 1000);
    // 100 (Replayed, kept above) + 300 = 400 bytes against a cap of 250: two must go, oldest-played first.
    await pruneVideosToCap(ctx);
    expect(existsSync(old.path)).toBe(false);
    expect(existsSync(played.path)).toBe(false);
    expect(existsSync(fresh.path)).toBe(true); // within the day's grace, however the cap stands
    expect((ctx.db.prepare("SELECT COALESCE(SUM(video_bytes), 0) AS n FROM audio_asset WHERE video_path IS NOT NULL").get() as { n: number }).n).toBe(200);
  });
});
