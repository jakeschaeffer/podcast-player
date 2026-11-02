import { execFile } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { videoClipArgs } from "../src/core/clip/render.js";
import { buildApp } from "../src/http/app.js";
import { newId, newShareToken } from "../src/lib/ids.js";
import { probeAudio } from "../src/lib/ffprobe.js";
import { pruneOldClips, queueMissingVideoClips, renderVideoClipJob } from "../src/services/snipJobs.js";
import { testContext } from "./helpers/context.js";

const execFileAsync = promisify(execFile);

/**
 * A snip cut from a video gets an MP4 and poster for its public page. The MP3 stays the clip of record: pages play it
 * until the picture exists, and a snip from a plain podcast never has one.
 */
describe("video clips on public pages", () => {
  const ctx = testContext();
  let app: FastifyInstance;
  const feedId = newId();
  const episodeId = newId();
  const assetId = newId();
  let videoPath = "";
  let mp3Path = "";

  /** A ready snip on the asset, with its MP3 on disk; returns its token and revision id. */
  const snip = (asset = assetId) => {
    const id = newId();
    const rev = newId();
    const token = newShareToken();
    ctx.db.prepare("INSERT INTO snip (id, audio_asset_id, anchor_ms, heard_from_ms, client_request_id, share_token, share_state, created_at) VALUES (?, ?, 5000, 0, ?, ?, 'active', 0)").run(id, asset, id, token);
    ctx.db
      .prepare("INSERT INTO snip_revision (id, snip_id, rev, method, start_ms, end_ms, title, summary_status, clip_path, clip_sha256, clip_duration_ms, status, created_at) VALUES (?, ?, 1, 'manual', 2000, 5000, 'A title', 'skipped', ?, 'sha', 3000, 'ready', 0)")
      .run(rev, id, mp3Path);
    ctx.db.prepare("UPDATE snip SET current_revision_id = ? WHERE id = ?").run(rev, id);
    return { id, rev, token };
  };
  const job = (revision_id: string) => ({ payload: { revision_id } }) as never;

  beforeAll(async () => {
    mkdirSync(ctx.paths.assets, { recursive: true });
    videoPath = join(ctx.paths.assets, "source.mp4");
    mp3Path = join(ctx.paths.clips, "audio.mp3");
    await execFileAsync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=321x241:rate=10", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "10", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-vf", "pad=322:242", "-c:a", "aac", "-shortest", videoPath]);
    await execFileAsync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=3", "-c:a", "libmp3lame", mp3Path]);
    ctx.db.prepare("INSERT INTO feed (id, url_enc, url_hash, title, created_at) VALUES (?, ?, ?, 'Show', 0)").run(feedId, Buffer.from("x"), feedId);
    ctx.db.prepare("INSERT INTO episode (id, feed_id, guid, title, first_seen_at, enclosure_url_enc) VALUES (?, ?, ?, 'Episode', 0, ?)").run(episodeId, feedId, episodeId, Buffer.from("x"));
    ctx.db
      .prepare("INSERT INTO audio_asset (id, episode_id, sha256, bytes, duration_ms, mime, path, pinned, created_at, video_path, video_sha256, video_bytes, video_width, video_height) VALUES (?, ?, 'audio-sha', 10, 10000, 'audio/mp4', '/audio', 0, 0, ?, 'video-sha', 100, 322, 242)")
      .run(assetId, episodeId, videoPath);
    app = await buildApp(ctx);
  });
  afterAll(async () => {
    await app.close();
  });

  it("cuts exactly the span, in a format every browser plays, with no metadata from the parent", async () => {
    const args = videoClipArgs("/v.mp4", 2000, 5000, "/o.mp4");
    expect(args.slice(args.indexOf("-ss"), args.indexOf("-ss") + 6)).toEqual(["-ss", "2.000", "-i", "/v.mp4", "-t", "3.000"]);
    expect(args).toEqual(expect.arrayContaining(["-map_metadata", "-1", "-map_chapters", "-1", "libx264", "yuv420p", "+faststart"]));
    expect(() => videoClipArgs("/v.mp4", 5000, 2000, "/o.mp4")).toThrow(RangeError);
  });

  it("plays the audio until the picture exists, then the video, with its poster and preview tags", async () => {
    const { rev, token } = snip();
    const before = await app.inject({ method: "GET", url: `/s/${token}` });
    expect(before.body).toContain("<audio");
    expect(before.body).not.toContain("<video");
    expect(before.body).not.toContain("og:video");
    expect((await app.inject({ method: "GET", url: `/s/${token}/r1.mp4` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/s/${token}/r1.jpg` })).statusCode).toBe(404);

    await renderVideoClipJob(ctx, job(rev));

    const path = join(ctx.paths.clips, `${rev}.mp4`);
    const probe = await probeAudio(path);
    expect(Math.abs(probe.duration_ms - 3000)).toBeLessThan(250);
    expect(probe.video?.codec).toBe("h264");
    expect(probe.mime).toBe("video/mp4");

    const page = await app.inject({ method: "GET", url: `/s/${token}` });
    expect(page.body).toContain(`src="${ctx.config.publicBaseUrl}/s/${token}/r1.mp4"`);
    expect(page.body).toContain(`poster="${ctx.config.publicBaseUrl}/s/${token}/r1.jpg"`);
    expect(page.body).toContain("playsinline");
    expect(page.body).not.toContain("<audio");
    expect(page.body).toContain(`<meta property="og:video:type" content="video/mp4">`);
    expect(page.body).toContain(`<meta property="og:type" content="video.other">`);
    expect(page.body).toContain("og:audio"); // previews that only play audio keep working

    const clip = await app.inject({ method: "GET", url: `/s/${token}/r1.mp4`, headers: { range: "bytes=0-9" } });
    expect(clip.statusCode).toBe(206);
    expect(clip.headers["content-type"]).toBe("video/mp4");
    expect(clip.headers["cache-control"]).toContain("immutable");
    const poster = await app.inject({ method: "GET", url: `/s/${token}/r1.jpg` });
    expect(poster.statusCode).toBe(200);
    expect(poster.headers["content-type"]).toBe("image/jpeg");
    expect(poster.rawPayload.subarray(0, 2).toString("hex")).toBe("ffd8");
    expect((await app.inject({ method: "GET", url: `/s/${token}/r2.mp4` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/s/${token}/r1.mov` })).statusCode).toBe(404);

    const json = await app.inject({ method: "GET", url: `/s/${token}.json` });
    expect(json.json().video).toEqual({ url: `${ctx.config.publicBaseUrl}/s/${token}/r1.mp4`, poster_url: `${ctx.config.publicBaseUrl}/s/${token}/r1.jpg`, width: probe.video!.width, height: probe.video!.height });
  });

  it("withdraws the picture with the snip", async () => {
    const { id, rev, token } = snip();
    await renderVideoClipJob(ctx, job(rev));
    ctx.db.prepare("UPDATE snip SET share_state = 'revoked' WHERE id = ?").run(id);
    expect((await app.inject({ method: "GET", url: `/s/${token}/r1.mp4` })).statusCode).toBe(410);
    expect((await app.inject({ method: "GET", url: `/s/${token}/r1.jpg` })).statusCode).toBe(410);
  });

  it("does nothing for a recording with no video, and picks the snip up when its video comes back as a new recording", async () => {
    const dropped = newId();
    ctx.db.prepare("INSERT INTO audio_asset (id, episode_id, sha256, bytes, duration_ms, mime, path, pinned, created_at) VALUES (?, ?, 'other-audio', 10, 10000, 'audio/mp4', '/audio', 0, 0)").run(dropped, episodeId);
    const { rev, token } = snip(dropped);
    await renderVideoClipJob(ctx, job(rev));
    expect((await app.inject({ method: "GET", url: `/s/${token}` })).body).toContain("<audio");
    expect(existsSync(join(ctx.paths.clips, `${rev}.mp4`))).toBe(false);
    const key = `render_video_clip:${rev}`;
    ctx.queue.enqueue("render_video_clip", key, { revision_id: rev });
    ctx.db.prepare("UPDATE job SET status = 'done' WHERE key = ?").run(key);

    // Still nothing to cut from: a different audio track is a different timeline, even in the same episode.
    queueMissingVideoClips(ctx);
    expect(ctx.queue.byKey(key)?.status).toBe("done");

    // The same audio bytes, with the video again.
    ctx.db
      .prepare("INSERT INTO audio_asset (id, episode_id, sha256, bytes, duration_ms, mime, path, pinned, created_at, video_path, video_sha256, video_bytes, video_width, video_height) VALUES (?, ?, 'other-audio', 10, 10000, 'audio/mp4', '/audio', 0, 0, ?, 'video-sha', 100, 322, 242)")
      .run(newId(), episodeId, videoPath);
    queueMissingVideoClips(ctx);
    expect(ctx.queue.byKey(key)?.status).toBe("queued");
    await renderVideoClipJob(ctx, job(rev));
    expect((await app.inject({ method: "GET", url: `/s/${token}` })).body).toContain("<video");
  });

  it("leaves a failed render failed rather than retrying it every hour", () => {
    const { rev } = snip();
    const key = `render_video_clip:${rev}`;
    ctx.queue.enqueue("render_video_clip", key, { revision_id: rev });
    ctx.db.prepare("UPDATE job SET status = 'failed' WHERE key = ?").run(key);
    queueMissingVideoClips(ctx);
    expect(ctx.queue.byKey(key)?.status).toBe("failed");
  });

  it("removes a superseded revision's picture and poster with its clip", async () => {
    const { id, rev } = snip();
    await renderVideoClipJob(ctx, job(rev));
    const mp4 = join(ctx.paths.clips, `${rev}.mp4`);
    const jpg = join(ctx.paths.clips, `${rev}.jpg`);
    expect(statSync(mp4).size).toBeGreaterThan(0);
    expect(existsSync(jpg)).toBe(true);
    const next = newId();
    ctx.db.prepare("INSERT INTO snip_revision (id, snip_id, rev, method, start_ms, end_ms, summary_status, status, created_at) VALUES (?, ?, 2, 'manual', 2000, 6000, 'skipped', 'preparing', ?)").run(next, id, ctx.now());
    ctx.db.prepare("UPDATE snip SET current_revision_id = ? WHERE id = ?").run(next, id);
    await pruneOldClips(ctx, -1);
    expect(existsSync(mp4)).toBe(false);
    expect(existsSync(jpg)).toBe(false);
  });
});
