import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../src/app/context.js";
import { buildApp } from "../src/http/app.js";
import { drain } from "../src/jobs/worker.js";
import { newId } from "../src/lib/ids.js";
import { refreshFeed } from "../src/services/feeds.js";
import { titleFor } from "../src/services/links.js";
import { testContext } from "./helpers/context.js";

const execFileAsync = promisify(execFile);

/**
 * A pasted link to a media file (services/links.ts) becomes a one-off episode of the Pasted links show, which the
 * server downloads and transcribes itself. The files come from a local server that answers like a CDN would: the
 * video honours byte ranges, the others ignore them.
 */
describe("pasted links", () => {
  let fixtures: Server;
  let baseUrl: string;
  let ctx: AppContext;
  let app: FastifyInstance;
  let token: string;
  const auth = () => ({ authorization: `Bearer ${token}` });
  const paste = (body: Record<string, unknown>) => app.inject({ method: "POST", url: "/v1/links/episodes", headers: auth(), payload: body });

  beforeAll(async () => {
    ctx = testContext();
    const mp4Path = join(ctx.paths.tmp, "clip.mp4");
    const mp3Path = join(ctx.paths.tmp, "tone.mp3");
    await execFileAsync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", mp4Path]);
    await execFileAsync("ffmpeg", ["-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=330:duration=3", "-c:a", "libmp3lame", "-b:a", "64k", mp3Path]);
    const mp4 = await readFile(mp4Path);
    const mp3 = await readFile(mp3Path);
    fixtures = createServer((req, res) => {
      const path = req.url ?? "/";
      if (path.startsWith("/clip.mp4")) {
        // A CDN: one byte when one is asked for, with the whole file's size in Content-Range.
        const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
        if (range) {
          const start = Number(range[1]);
          const end = range[2] ? Number(range[2]) : mp4.length - 1;
          res.writeHead(206, { "content-type": "video/mp4", "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${mp4.length}` });
          res.end(mp4.subarray(start, end + 1));
        } else {
          res.writeHead(200, { "content-type": "video/mp4", "content-length": String(mp4.length) });
          res.end(mp4);
        }
      } else if (path === "/tone.mp3") {
        res.writeHead(200, { "content-type": "audio/mpeg", "content-length": String(mp3.length), "content-disposition": 'attachment; filename="morning_tone.mp3"' });
        res.end(mp3);
      } else if (path === "/blob/7f3a") {
        // Named nothing, typed nothing useful: taken for a video until the download says otherwise.
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(mp3.length) });
        res.end(mp3);
      } else if (path === "/post/123") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<html><body><video src='/clip.mp4'></video></body></html>");
      } else if (path === "/feed.xml") {
        res.writeHead(200, { "content-type": "application/rss+xml" });
        res.end("<rss/>");
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => fixtures.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(fixtures.address() as { port: number }).port}`;
    app = await buildApp(ctx);
    const login = await app.inject({ method: "POST", url: "/v1/devices", payload: { name: "test", platform: "cli", password: "hunter2" } });
    token = login.json().token;
  });
  afterAll(async () => {
    await app.close();
    fixtures.close();
  });

  it("refuses a web page, a feed, a channel and anything that is not a link, before making any row", async () => {
    const page = await paste({ url: `${baseUrl}/post/123` });
    expect(page.statusCode).toBe(400);
    expect(page.json().error.message).toMatch(/web page/);
    expect((await paste({ url: `${baseUrl}/feed.xml` })).json().error.message).toMatch(/feed/);
    expect((await paste({ url: "https://www.youtube.com/@DwarkeshPatel" })).json().error.message).toMatch(/channel/);
    expect((await paste({ url: "not a link" })).statusCode).toBe(400);
    expect((await paste({ url: `${baseUrl}/missing.mp4` })).json().error.message).toMatch(/404/);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM episode").get()).toEqual({ n: 0 });
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM feed WHERE kind = 'links'").get()).toEqual({ n: 1 });
  });

  it("makes a video link a one-off of the Pasted links show, downloads it and queues its transcription", async () => {
    const res = await paste({ url: `${baseUrl}/clip.mp4?tag=29` });
    expect(res.statusCode, res.body).toBe(201);
    const ep = res.json();
    expect(ep.show_title).toBe("Pasted links");
    expect(ep.media_kind).toBe("video");
    expect(ep.title).toBe("clip");
    expect(ep.link).toBe(`${baseUrl}/clip.mp4?tag=29`);
    expect(ep.processing.audio).toBe("queued");
    expect(ep.video).toEqual({ status: "available", error: null });
    const feeds = (await app.inject({ method: "GET", url: "/v1/feeds", headers: auth() })).json();
    const links = feeds.find((f: { kind: string }) => f.kind === "links");
    expect(links).toMatchObject({ title: "Pasted links", followed: true, episode_count: 1 });
    expect(links.last_refresh_at).not.toBeNull();
    // The same link again is the same episode.
    expect((await paste({ url: `${baseUrl}/clip.mp4?tag=29` })).json().id).toBe(ep.id);

    const ran = await drain(ctx, { kinds: ["fetch_audio"] });
    expect(ran.outcomes.done).toBe(1);
    const after = (await app.inject({ method: "GET", url: `/v1/episodes/${ep.id}`, headers: auth() })).json();
    expect(after.video.status).toBe("ready");
    expect(after.asset.video_url).toMatch(/\/m\/videos\//);
    expect(after.asset.video_width).toBe(320);
    expect(ctx.queue.byKey(`transcribe:${after.asset.id}`)?.status).toBe("queued");
    // It shows in Today like any followed show's new episode.
    const today = (await app.inject({ method: "GET", url: "/v1/episodes?limit=10", headers: auth() })).json();
    expect(today.items.map((e: { id: string }) => e.id)).toContain(ep.id);
  });

  it("takes an audio link, naming it after the file, and corrects an untyped link that turns out to be audio", async () => {
    const audio = (await paste({ url: `${baseUrl}/tone.mp3` })).json();
    expect(audio.media_kind).toBe("audio");
    expect(audio.title).toBe("morning tone");
    expect(audio.video).toEqual({ status: "none", error: null });
    const blob = (await paste({ url: `${baseUrl}/blob/7f3a`, title: "A talk someone sent me" })).json();
    expect(blob.media_kind).toBe("video");
    expect(blob.title).toBe("A talk someone sent me");
    await drain(ctx, { kinds: ["fetch_audio"] });
    const after = (await app.inject({ method: "GET", url: `/v1/episodes/${blob.id}`, headers: auth() })).json();
    expect(after.media_kind).toBe("audio");
    expect(after.asset.video_url).toBeNull();
    expect(after.video).toEqual({ status: "none", error: null });
  });

  it("hands a YouTube video link to the channel path, and refreshing the links show does nothing", async () => {
    const feedId = newId();
    const episode = newId();
    ctx.db.prepare("INSERT INTO feed (id, url_enc, url_hash, title, created_at) VALUES (?, ?, ?, 'Show', 0)").run(feedId, Buffer.from("x"), feedId);
    ctx.db.prepare("INSERT INTO episode (id, feed_id, guid, title, first_seen_at, enclosure_url_enc, media_kind, youtube_id) VALUES (?, ?, ?, 'Caro', 0, ?, 'audio', 'f0J_EeW42Lo')").run(episode, feedId, episode, Buffer.from("x"));
    const res = await paste({ url: "https://youtu.be/f0J_EeW42Lo" });
    expect(res.statusCode).toBe(201);
    expect(res.json().id).toBe(episode);
    const links = ctx.db.prepare("SELECT id FROM feed WHERE kind = 'links'").pluck().get() as string;
    expect(await refreshFeed(ctx, links)).toMatchObject({ not_modified: true, new_episodes: 0 });
  });

  it("names a one-off after a readable file name, else after where it came from", () => {
    const at = (url: string, filename: string | null = null) => titleFor(new URL(url), { media_kind: "video", filename });
    expect(at("https://cdn.example.com/talks/keynote-2026.mp4")).toBe("keynote-2026");
    expect(at("https://cdn.example.com/talks/Why_we_left.mp4?x=1")).toBe("Why we left");
    expect(at("https://cdn.example.com/talks/intro.mp4")).toBe("intro");
    expect(at("https://video.twimg.com/amplify_video/2117182449197404160/vid/avc1/3840x2160/jEEwY1sNJVlzBYOx.mp4?tag=29")).toBe("Video from video.twimg.com");
    expect(at("https://cdn.example.com/dl?id=9", "Fireside chat.mp4")).toBe("Fireside chat");
    expect(at("https://www.example.com/")).toBe("Video from example.com");
  });
});
