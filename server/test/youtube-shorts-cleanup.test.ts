import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { newId } from "../src/lib/ids.js";
import { removeYouTubeShorts } from "../src/services/shorts.js";
import { testContext } from "./helpers/context.js";

it("removes every Short from the library, played or not, and keeps the channel's videos", async () => {
  const ctx = testContext();
  const dir = mkdtempSync(join(tmpdir(), "pp-shorts-"));
  const feedId = newId();
  ctx.db.prepare("INSERT INTO feed (id, url_enc, url_hash, title, kind, created_at) VALUES (?, ?, ?, 'Channel', 'youtube', 0)").run(feedId, Buffer.from("x"), feedId);
  const video = (youtubeId: string, path: "shorts" | "watch") => {
    const id = newId();
    const link = path === "shorts" ? `https://www.youtube.com/shorts/${youtubeId}` : `https://www.youtube.com/watch?v=${youtubeId}`;
    ctx.db
      .prepare("INSERT INTO episode (id, feed_id, guid, title, first_seen_at, enclosure_url_enc, enclosure_type, media_kind, youtube_id, link) VALUES (?, ?, ?, ?, 0, ?, 'video/youtube', 'video', ?, ?)")
      .run(id, feedId, `yt:video:${youtubeId}`, youtubeId, Buffer.from("x"), youtubeId, link);
    return id;
  };
  const played = video("QAE9nRTHtas", "shorts");
  const untouched = video("Ru0l6G5oq7U", "shorts");
  const kept = video("SyHM5hNPAEo", "watch");

  // The played Short has its recording, transcript, playback, a place in Up Next and a finished job.
  const asset = newId();
  const audio = join(dir, "a.m4a");
  const mp4 = join(dir, "v.mp4");
  writeFileSync(audio, "a");
  writeFileSync(mp4, "v");
  ctx.db.prepare("INSERT INTO audio_asset (id, episode_id, sha256, bytes, duration_ms, mime, path, video_path, created_at) VALUES (?, ?, ?, 1, 30000, 'audio/mp4', ?, ?, 0)").run(asset, played, asset, audio, mp4);
  const transcript = newId();
  ctx.db.prepare("INSERT INTO transcript (id, audio_asset_id, provider, model, word_count, created_at) VALUES (?, ?, 'youtube', 'captions', 10, 0)").run(transcript, asset);
  ctx.db.prepare("UPDATE audio_asset SET transcript_id = ? WHERE id = ?").run(transcript, asset);
  ctx.db.prepare("UPDATE episode SET current_asset_id = ? WHERE id = ?").run(asset, played);
  const device = newId();
  ctx.db.prepare("INSERT INTO device (id, name, platform, token_hash, created_at) VALUES (?, 'phone', 'ios', ?, 0)").run(device, device);
  ctx.db.prepare("INSERT INTO playback_state (device_id, audio_asset_id, position_ms, seq, updated_at) VALUES (?, ?, 30000, 1, 0)").run(device, asset);
  ctx.db.prepare("INSERT INTO up_next (episode_id, position, added_at) VALUES (?, 1, 0)").run(played);
  ctx.queue.enqueue("fetch_video", `fetch_video:${untouched}`, { episode_id: untouched });

  expect(await removeYouTubeShorts(ctx)).toEqual({ removed: 2, kept_for_snips: 0 });
  expect(ctx.db.prepare("SELECT id FROM episode").pluck().all()).toEqual([kept]);
  for (const table of ["audio_asset", "transcript", "playback_state", "up_next"]) expect(ctx.db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()).toBe(0);
  expect(ctx.db.prepare("SELECT COUNT(*) FROM job WHERE key = ?").pluck().get(`fetch_video:${untouched}`)).toBe(0);
  expect(existsSync(audio) || existsSync(mp4)).toBe(false);
  expect(await removeYouTubeShorts(ctx)).toEqual({ removed: 0, kept_for_snips: 0 });
  ctx.db.close();
});
