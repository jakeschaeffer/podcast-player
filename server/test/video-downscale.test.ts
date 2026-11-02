import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/http/app.js";
import { newId } from "../src/lib/ids.js";
import { testContext } from "./helpers/context.js";

const execFileAsync = promisify(execFile);

/** A video taller than VIDEO_MAX_HEIGHT is scaled down before it is kept (services/video.ts, downscaleIfTall). */
describe("video downscale", () => {
  const ctx = testContext({ config: { videoMaxHeight: 240 } });
  let app: FastifyInstance;
  let token: string;
  let hd: Buffer;
  let tall: Buffer;
  const feedId = newId();
  const auth = () => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "pp-downscale-"));
    const make = async (name: string, size: string) => {
      const path = join(dir, name);
      await execFileAsync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc=size=${size}:rate=10`, "-f", "lavfi", "-i", "sine=frequency=440", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path]);
      return readFileSync(path);
    };
    hd = await make("hd.mp4", "1280x720");
    tall = await make("tall.mp4", "720x1280");
    ctx.db.prepare("INSERT INTO feed (id, url_enc, url_hash, title, kind, created_at) VALUES (?, ?, ?, 'Channel', 'youtube', 0)").run(feedId, Buffer.from("x"), feedId);
    app = await buildApp(ctx);
    const login = await app.inject({ method: "POST", url: "/v1/devices", payload: { name: "test", platform: "cli", password: "hunter2" } });
    token = login.json().token;
  });
  afterAll(async () => {
    await app.close();
  });

  const episode = (id: string) => {
    ctx.db
      .prepare("INSERT INTO episode (id, feed_id, guid, title, first_seen_at, enclosure_url_enc, enclosure_type, media_kind, youtube_id) VALUES (?, ?, ?, 'v', 0, ?, 'video/youtube', 'video', ?)")
      .run(id, feedId, id, Buffer.from("x"), id.slice(0, 11));
    return id;
  };
  const upload = (id: string, body: Buffer) => app.inject({ method: "PUT", url: `/v1/episodes/${id}/video/file`, headers: { ...auth(), "content-type": "video/mp4" }, payload: body });

  it("scales a landscape video down to the limit on its height, keeping the sound", async () => {
    const id = episode(newId());
    const res = await upload(id, hd);
    expect(res.statusCode, res.body).toBe(200);
    const asset = res.json().asset;
    expect(asset.video_height).toBe(240);
    expect(asset.video_width).toBe(426);
    expect(asset.video_bytes).toBeLessThan(hd.length);
    expect(asset.duration_ms).toBeGreaterThan(1500);
    expect(asset.mime).toBe("audio/mp4");
  });

  it("scales a portrait video down on its width", async () => {
    const id = episode(newId());
    const asset = (await upload(id, tall)).json().asset;
    expect(asset.video_width).toBe(240);
    expect(asset.video_height).toBe(426);
  });

  it("leaves a video at or under the limit as it is", async () => {
    const small = testContext({ config: { videoMaxHeight: 720 } });
    small.db.prepare("INSERT INTO feed (id, url_enc, url_hash, title, kind, created_at) VALUES (?, ?, ?, 'Channel', 'youtube', 0)").run(feedId, Buffer.from("x"), feedId);
    const id = newId();
    small.db
      .prepare("INSERT INTO episode (id, feed_id, guid, title, first_seen_at, enclosure_url_enc, enclosure_type, media_kind, youtube_id) VALUES (?, ?, ?, 'v', 0, ?, 'video/youtube', 'video', ?)")
      .run(id, feedId, id, Buffer.from("x"), id.slice(0, 11));
    const smallApp = await buildApp(small);
    const login = await smallApp.inject({ method: "POST", url: "/v1/devices", payload: { name: "test", platform: "cli", password: "hunter2" } });
    const res = await smallApp.inject({ method: "PUT", url: `/v1/episodes/${id}/video/file`, headers: { authorization: `Bearer ${login.json().token}`, "content-type": "video/mp4" }, payload: hd });
    expect(res.json().asset).toMatchObject({ video_width: 1280, video_height: 720, video_bytes: hd.length });
    await smallApp.close();
  });
});
