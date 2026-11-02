import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
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

/**
 * A video arrives the way the home fetcher sends one (fetcher/snip_fetcher.py): the owner asks for it, the fetcher
 * sees it wanted, uploads the MP4 and its captions, and says it is done. The file is a two-second test pattern with a
 * tone, made here with ffmpeg (which the server needs anyway).
 */
describe("video", () => {
  const ctx = testContext();
  let app: FastifyInstance;
  let token: string;
  let mp4: Buffer;
  const feedId = newId();
  const channelEpisode = newId();
  const auth = () => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "pp-video-"));
    const path = join(dir, "clip.mp4");
    await execFileAsync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path]);
    mp4 = readFileSync(path);
    expect(statSync(path).size).toBeGreaterThan(1000);

    ctx.db.prepare("INSERT INTO feed (id, url_enc, url_hash, title, kind, created_at) VALUES (?, ?, ?, 'Dwarkesh Patel', 'youtube', 0)").run(feedId, Buffer.from("x"), feedId);
    ctx.db
      .prepare("INSERT INTO episode (id, feed_id, guid, title, first_seen_at, enclosure_url_enc, enclosure_type, media_kind, youtube_id, link) VALUES (?, ?, ?, ?, 0, ?, 'video/youtube', 'video', ?, ?)")
      .run(channelEpisode, feedId, "yt:video:bJD1NpdMY5s", "What will automated firms look like?", ctx.secrets.encrypt("https://www.youtube.com/watch?v=bJD1NpdMY5s"), "bJD1NpdMY5s", "https://www.youtube.com/watch?v=bJD1NpdMY5s");
    app = await buildApp(ctx);
    const login = await app.inject({ method: "POST", url: "/v1/devices", payload: { name: "test", platform: "cli", password: "hunter2" } });
    token = login.json().token;
  });
  afterAll(async () => {
    await app.close();
  });

  const detail = async (id: string) => (await app.inject({ method: "GET", url: `/v1/episodes/${id}`, headers: auth() })).json();

  it("is 'available' on a channel's video until the owner asks, then 'requested' and wanted by the fetcher", async () => {
    expect((await detail(channelEpisode)).video).toEqual({ status: "available", error: null });
    expect((await detail(channelEpisode)).media_kind).toBe("video");
    const asked = await app.inject({ method: "POST", url: `/v1/episodes/${channelEpisode}/video`, headers: auth() });
    expect(asked.statusCode).toBe(202);
    expect(asked.json().video.status).toBe("requested");
    const wanted = (await app.inject({ method: "GET", url: "/v1/video/wanted", headers: auth() })).json();
    expect(wanted.items).toEqual([expect.objectContaining({ episode_id: channelEpisode, youtube_id: "bJD1NpdMY5s", title: "What will automated firms look like?", show_title: "Dwarkesh Patel" })]);
    // Opening it in the player asks the same way, and parks the audio fetch on the fetcher.
    const play = await app.inject({ method: "POST", url: `/v1/episodes/${channelEpisode}/audio`, headers: auth() });
    expect(play.statusCode).toBe(202);
    expect(play.json().asset).toBeNull();
  });

  it("refuses captions before the video, and a file that is not a video", async () => {
    const early = await app.inject({ method: "PUT", url: `/v1/episodes/${channelEpisode}/video/captions?kind=auto&lang=en`, headers: auth(), payload: { events: [] } });
    expect(early.statusCode).toBe(409);
    const junk = await app.inject({ method: "PUT", url: `/v1/episodes/${channelEpisode}/video/file`, headers: { ...auth(), "content-type": "video/mp4" }, payload: Buffer.from("not a video at all") });
    expect(junk.statusCode).toBeGreaterThanOrEqual(400);
    expect((await detail(channelEpisode)).video.status).toBe("requested");
  });

  it("stores the uploaded video as the episode's recording, with its audio pulled out beside it", async () => {
    const up = await app.inject({ method: "PUT", url: `/v1/episodes/${channelEpisode}/video/file`, headers: { ...auth(), "content-type": "video/mp4" }, payload: mp4 });
    expect(up.statusCode, up.body).toBe(200);
    const ep = up.json();
    expect(ep.video).toEqual({ status: "ready", error: null });
    expect(ep.asset.video_url).toMatch(/\/m\/videos\//);
    expect(ep.asset.video_width).toBe(320);
    expect(ep.asset.video_height).toBe(240);
    expect(ep.asset.video_bytes).toBe(mp4.length);
    expect(ep.asset.duration_ms).toBeGreaterThan(1500);
    expect(ep.asset.duration_ms).toBeLessThan(2500);
    expect(ep.asset.mime).toMatch(/^audio\//); // the audio file, for everything built on audio
    expect(ep.asset.audio_url).toMatch(/\/m\/assets\//);
    expect((await app.inject({ method: "GET", url: "/v1/video/wanted", headers: auth() })).json().items).toEqual([]);

    // The same file again is one asset, not two.
    const again = await app.inject({ method: "PUT", url: `/v1/episodes/${channelEpisode}/video/file`, headers: { ...auth(), "content-type": "video/mp4" }, payload: mp4 });
    expect(again.json().asset.id).toBe(ep.asset.id);
    expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM audio_asset WHERE episode_id = ?").get(channelEpisode) as { n: number }).n).toBe(1);
  });

  it("serves the video and the audio with signed URLs, with Range", async () => {
    const ep = await detail(channelEpisode);
    const video = await app.inject({ method: "GET", url: new URL(ep.asset.video_url).pathname + new URL(ep.asset.video_url).search, headers: { range: "bytes=0-99" } });
    expect(video.statusCode).toBe(206);
    expect(video.headers["content-type"]).toBe("video/mp4");
    expect(video.rawPayload.length).toBe(100);
    expect(video.rawPayload.subarray(4, 8).toString()).toBe("ftyp");
    const audio = await app.inject({ method: "GET", url: new URL(ep.asset.audio_url).pathname + new URL(ep.asset.audio_url).search });
    expect(audio.statusCode).toBe(200);
    expect(audio.headers["content-type"]).toMatch(/^audio\//);
    const forged = new URL(ep.asset.video_url);
    forged.searchParams.set("s", "0".repeat(64));
    expect((await app.inject({ method: "GET", url: forged.pathname + forged.search })).statusCode).toBe(401);
  });

  it("makes the captions the transcript, and 'done' then needs no transcription", async () => {
    const json3 = { events: [{ tStartMs: 0, dDurationMs: 900, segs: [{ utf8: "When" }, { utf8: " people", tOffsetMs: 300 }, { utf8: " think", tOffsetMs: 600 }] }, { tStartMs: 900, dDurationMs: 800, segs: [{ utf8: "of" }, { utf8: " AGI.", tOffsetMs: 300 }] }] };
    const caps = await app.inject({ method: "PUT", url: `/v1/episodes/${channelEpisode}/video/captions?kind=auto&lang=en`, headers: auth(), payload: json3 });
    expect(caps.statusCode, caps.body).toBe(200);
    expect(caps.json()).toMatchObject({ word_count: 5, current: true });
    const ep = await detail(channelEpisode);
    expect(ep.transcript_id).toBe(caps.json().transcript_id);
    expect(ep.processing.transcript).toBe("ready");
    const row = ctx.db.prepare("SELECT provider, model, source FROM transcript WHERE id = ?").get(ep.transcript_id);
    expect(row).toEqual({ provider: "youtube", model: "captions-auto", source: "captions" });
    const transcript = (await app.inject({ method: "GET", url: `/v1/transcripts/${ep.transcript_id}`, headers: auth() })).json();
    expect(transcript.segments.flatMap((s: { words: [number, number, string][] }) => s.words.map((w) => w[2]))).toEqual(["When", "people", "think", "of", "AGI."]);

    const done = await app.inject({ method: "POST", url: `/v1/episodes/${channelEpisode}/video/done`, headers: auth() });
    expect(done.statusCode).toBe(200);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM job WHERE kind = 'transcribe' AND key = ?").get(`transcribe:${ep.asset_id}`)).toEqual({ n: 0 });
  });

  it("records a failure the fetcher reports, until the owner asks again", async () => {
    const other = newId();
    ctx.db
      .prepare("INSERT INTO episode (id, feed_id, guid, title, first_seen_at, enclosure_url_enc, enclosure_type, media_kind, youtube_id) VALUES (?, ?, ?, 'Gone', 0, ?, 'video/youtube', 'video', 'frYSOKvNiiE')")
      .run(other, feedId, "yt:video:frYSOKvNiiE", ctx.secrets.encrypt("https://www.youtube.com/watch?v=frYSOKvNiiE"));
    await app.inject({ method: "POST", url: `/v1/episodes/${other}/video`, headers: auth() });
    const failed = await app.inject({ method: "POST", url: `/v1/episodes/${other}/video/failed`, headers: auth(), payload: { message: "yt-dlp: Video unavailable" } });
    expect(failed.json().video).toEqual({ status: "failed", error: "yt-dlp: Video unavailable" });
    expect((await app.inject({ method: "GET", url: "/v1/video/wanted", headers: auth() })).json().items).toEqual([]);
    const asked = await app.inject({ method: "POST", url: `/v1/episodes/${other}/video`, headers: auth() });
    expect(asked.json().video).toEqual({ status: "requested", error: null });
  });

  it("lets the owner name another YouTube video after a failed one, and forgets a failure with it", async () => {
    const other = (ctx.db.prepare("SELECT id FROM episode WHERE title = 'Gone'").get() as { id: string }).id;
    await app.inject({ method: "POST", url: `/v1/episodes/${other}/video/failed`, headers: auth(), payload: { message: "yt-dlp: removed by the uploader" } });
    expect((await detail(other)).video.status).toBe("failed");
    const bad = await app.inject({ method: "PATCH", url: `/v1/episodes/${other}`, headers: auth(), payload: { youtube_id: "nope" } });
    expect(bad.statusCode).toBe(400);
    const renamed = await app.inject({ method: "PATCH", url: `/v1/episodes/${other}`, headers: auth(), payload: { youtube_id: "f0J_EeW42Lo" } });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json()).toMatchObject({ youtube_id: "f0J_EeW42Lo", video: { status: "available", error: null } });
    await app.inject({ method: "POST", url: `/v1/episodes/${other}/video`, headers: auth() });
    expect((await app.inject({ method: "GET", url: "/v1/video/wanted", headers: auth() })).json().items).toEqual([expect.objectContaining({ episode_id: other, youtube_id: "f0J_EeW42Lo" })]);
    // A channel's own video cannot be forgotten.
    expect((await app.inject({ method: "PATCH", url: `/v1/episodes/${other}`, headers: auth(), payload: { youtube_id: null } })).statusCode).toBe(400);
  });

  it("has no video to offer for a plain audio episode", async () => {
    const plain = newId();
    ctx.db.prepare("INSERT INTO episode (id, feed_id, guid, title, first_seen_at, enclosure_url_enc) VALUES (?, ?, ?, 'Audio only', 0, ?)").run(plain, feedId, plain, Buffer.from("x"));
    expect((await detail(plain)).video).toEqual({ status: "none", error: null });
    expect((await app.inject({ method: "POST", url: `/v1/episodes/${plain}/video`, headers: auth() })).statusCode).toBe(400);
  });
});
