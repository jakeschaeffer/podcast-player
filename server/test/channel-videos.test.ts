import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/http/app.js";
import { newId } from "../src/lib/ids.js";
import { reportPlayback } from "../src/services/playback.js";
import { testContext } from "./helpers/context.js";

/**
 * Details first (docs/video-plan.md): opening a channel's video queues nothing, the home fetcher sends details and
 * older videos without downloading anything, and captions that fail never become a paid transcription.
 */
describe("channel videos", () => {
  const ctx = testContext();
  let app: FastifyInstance;
  let token: string;
  const feedId = newId();
  const episode = newId();
  const auth = () => ({ authorization: `Bearer ${token}` });
  const jobs = (kind: string) => (ctx.db.prepare("SELECT COUNT(*) AS n FROM job WHERE kind = ?").get(kind) as { n: number }).n;

  beforeAll(async () => {
    const url = "https://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv";
    ctx.db.prepare("INSERT INTO feed (id, url_enc, url_hash, title, kind, created_at) VALUES (?, ?, ?, 'Channel', 'youtube', 0)").run(feedId, ctx.secrets.encrypt(url), feedId);
    ctx.db
      .prepare("INSERT INTO episode (id, feed_id, guid, title, description_html, published_at, first_seen_at, enclosure_url_enc, enclosure_type, media_kind, youtube_id) VALUES (?, ?, 'yt:video:aaaaaaaaaaa', 'Newest', '<p>Notes</p>', 1000000, 0, ?, 'video/youtube', 'video', 'aaaaaaaaaaa')")
      .run(episode, feedId, ctx.secrets.encrypt("https://www.youtube.com/watch?v=aaaaaaaaaaa"));
    app = await buildApp(ctx);
    const res = await app.inject({ method: "POST", url: "/v1/devices", payload: { name: "fetcher", platform: "cli", password: ctx.config.ownerPassword } });
    token = res.json().token;
  });
  afterAll(() => app.close());

  it("opening a video reads its details and queues nothing", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/episodes/${episode}`, headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json().description_html).toContain("Notes");
    expect(res.json().video.status).toBe("available");
    expect(jobs("fetch_video")).toBe(0);
  });

  it("stores a video's details, and stops asking for them", async () => {
    const wanted = (await app.inject({ method: "GET", url: "/v1/video/metadata/wanted", headers: auth() })).json().items;
    expect(wanted.map((w: { episode_id: string }) => w.episode_id)).toContain(episode);
    const res = await app.inject({
      method: "PUT",
      url: `/v1/episodes/${episode}/video/metadata`,
      headers: auth(),
      payload: { description: "Line one\nhttps://example.com", duration_ms: 600000, chapters: [{ start_ms: 0, title: "Intro" }, { start_ms: 300000, title: "Middle" }] },
    });
    expect(res.statusCode).toBe(200);
    const detail = res.json();
    expect(detail.duration_ms).toBe(600000);
    expect(detail.title).toBe("Newest");
    expect(detail.description_html).toContain("Line one");
    expect(detail.chapters.items.map((c: { title: string }) => c.title)).toEqual(["Intro", "Middle"]);
    const after = (await app.inject({ method: "GET", url: "/v1/video/metadata/wanted", headers: auth() })).json().items;
    expect(after.map((w: { episode_id: string }) => w.episode_id)).not.toContain(episode);
    expect(jobs("fetch_video")).toBe(0);
  });

  it("lists the next fifteen new videos, walking past ones it has, with no downloads", async () => {
    const asked = await app.inject({ method: "POST", url: `/v1/feeds/${feedId}/more-videos`, headers: auth() });
    expect(asked.statusCode).toBe(202);
    expect(asked.json().more_videos.status).toBe("requested");
    await app.inject({ method: "POST", url: `/v1/feeds/${feedId}/more-videos`, headers: auth() }); // a double tap is one request
    let listing = (await app.inject({ method: "GET", url: "/v1/video/listings/wanted", headers: auth() })).json().items[0];
    expect(listing).toEqual({ feed_id: feedId, channel_id: "UCabcdefghijklmnopqrstuv", offset: 0, count: 15 });

    const id = (i: number) => `v${String(i).padStart(10, "0")}`;
    const page = ["aaaaaaaaaaa", ...Array.from({ length: 14 }, (_, i) => id(i))].map((youtube_id) => ({ youtube_id, title: youtube_id, duration_ms: 1000 }));
    const first = await app.inject({ method: "PUT", url: `/v1/feeds/${feedId}/videos`, headers: auth(), payload: { videos: page, ended: false } });
    expect(first.json()).toEqual({ added: 14, wanted: 1 });
    listing = (await app.inject({ method: "GET", url: "/v1/video/listings/wanted", headers: auth() })).json().items[0];
    expect(listing).toMatchObject({ offset: 15, count: 1 });

    const second = await app.inject({ method: "PUT", url: `/v1/feeds/${feedId}/videos`, headers: auth(), payload: { videos: [{ youtube_id: id(14), title: "Last" }], ended: false } });
    expect(second.json()).toEqual({ added: 1, wanted: 0 });
    expect((await app.inject({ method: "GET", url: "/v1/video/listings/wanted", headers: auth() })).json().items).toEqual([]);
    expect(jobs("fetch_video")).toBe(0);

    // Newest first, in the channel's own order, below what the feed gave.
    const list = (await app.inject({ method: "GET", url: `/v1/episodes?feed_id=${feedId}&limit=50`, headers: auth() })).json().items;
    expect(list.map((e: { title: string }) => e.title).slice(0, 3)).toEqual(["Newest", id(0), id(1)]);
    expect(list.at(-1).title).toBe("Last");
    expect(list).toHaveLength(16);
  });

  it("a failed listing shows, and the end of the channel stops the button", async () => {
    await app.inject({ method: "POST", url: `/v1/feeds/${feedId}/more-videos`, headers: auth() });
    const failed = await app.inject({ method: "POST", url: `/v1/feeds/${feedId}/videos/failed`, headers: auth(), payload: { message: "HTTP Error 429" } });
    expect(failed.json().more_videos).toEqual({ status: "failed", error: "HTTP Error 429" });
    await app.inject({ method: "POST", url: `/v1/feeds/${feedId}/more-videos`, headers: auth() });
    await app.inject({ method: "PUT", url: `/v1/feeds/${feedId}/videos`, headers: auth(), payload: { videos: [], ended: true } });
    const ended = await app.inject({ method: "POST", url: `/v1/feeds/${feedId}/more-videos`, headers: auth() });
    expect(ended.json().more_videos).toEqual({ status: "ended", error: null });
  });

  it("a failed video shows as a failed recording, so an older app's spinner ends", async () => {
    await app.inject({ method: "POST", url: `/v1/episodes/${episode}/audio`, headers: auth() });
    expect(jobs("fetch_video")).toBe(1);
    const res = await app.inject({ method: "POST", url: `/v1/episodes/${episode}/video/failed`, headers: auth(), payload: { message: "yt-dlp: 429" } });
    expect(res.json().processing.audio).toBe("failed");
    expect(res.json().video).toEqual({ status: "failed", error: "yt-dlp: 429" });
  });

  it("captions that fail never transcribe: not at once, and not on playing", async () => {
    const assetId = newId();
    ctx.db.prepare("UPDATE feed SET auto_process = 1 WHERE id = ?").run(feedId);
    ctx.db
      .prepare("INSERT INTO audio_asset (id, episode_id, sha256, bytes, duration_ms, mime, path, pinned, created_at, video_path, video_sha256, video_bytes) VALUES (?, ?, 'x', 1, 60000, 'audio/mp4', '/x', 0, 0, '/x.mp4', 'y', 1)")
      .run(assetId, episode);
    ctx.db.prepare("UPDATE episode SET current_asset_id = ? WHERE id = ?").run(assetId, episode);
    const device = ctx.db.prepare("SELECT id FROM device LIMIT 1").pluck().get() as string;

    const later = await app.inject({ method: "POST", url: `/v1/episodes/${episode}/video/captions/later`, headers: auth(), payload: { message: "HTTP Error 429" } });
    expect(later.json().retry_at).toBeGreaterThan(ctx.now() + 59 * 60 * 1000);
    expect(jobs("transcribe")).toBe(0);
    // Not due for an hour.
    expect((await app.inject({ method: "GET", url: "/v1/video/captions/wanted", headers: auth() })).json().items).toEqual([]);
    reportPlayback(ctx, device, assetId, { position_ms: 1000, speed: 1, playing: true, finished: false, seq: 1 });
    expect(jobs("transcribe")).toBe(0);

    ctx.db.prepare("UPDATE episode SET captions_retry_at = 1 WHERE id = ?").run(episode);
    expect((await app.inject({ method: "GET", url: "/v1/video/captions/wanted", headers: auth() })).json().items.map((w: { youtube_id: string }) => w.youtube_id)).toEqual(["aaaaaaaaaaa"]);

    // The tries run out: no more asking, and still nothing billed.
    for (let i = 0; i < 4; i++) await app.inject({ method: "POST", url: `/v1/episodes/${episode}/video/captions/later`, headers: auth(), payload: { message: "429" } });
    const last = await app.inject({ method: "POST", url: `/v1/episodes/${episode}/video/captions/later`, headers: auth(), payload: { message: "429" } });
    expect(last.json().retry_at).toBeNull();
    expect(jobs("transcribe")).toBe(0);
  });

  it("a new channel does not download on its own, unless asked up front", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/feeds", headers: auth(), payload: { url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCzzzzzzzzzzzzzzzzzzzzzz" } });
    expect(res.statusCode).toBe(201);
    expect(res.json().auto_process).toBe(false);
    expect(res.json().more_videos.status).toBe("idle");
  });
});
