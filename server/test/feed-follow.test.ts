import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TranscribeInput, Transcriber } from "../src/adapters/transcriber.js";
import type { RawTranscript } from "../src/core/transcript/types.js";
import type { AppContext } from "../src/app/context.js";
import { buildApp } from "../src/http/app.js";
import { drain } from "../src/jobs/worker.js";
import { scheduledFeedIds } from "../src/services/feeds.js";
import { FixedShowSearch, testContext } from "./helpers/context.js";

const execFileAsync = promisify(execFile);

class CountingTranscriber implements Transcriber {
  readonly name = "counting";
  calls: TranscribeInput[] = [];
  async transcribe(input: TranscribeInput): Promise<RawTranscript> {
    this.calls.push(input);
    return { language: "eng", words: [{ start_ms: 0, end_ms: 400, text: "Hello.", speaker: "S1" }] } as unknown as RawTranscript;
  }
}

// Opening a show from search without subscribing creates it unfollowed: its episodes are real rows (play, process,
// snip all work), but it stays out of the library's lists, Today's new episodes, and the scheduled refresh, and it
// never transcribes on its own.
describe("an unfollowed show", () => {
  let fixtures: Server;
  let baseUrl: string;
  let ctx: AppContext;
  let app: FastifyInstance;
  let token: string;
  const transcriber = new CountingTranscriber();
  const auth = () => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    ctx = testContext({ transcriber });
    const mp3Path = join(ctx.paths.tmp, "fixture.mp3");
    await execFileAsync("ffmpeg", ["-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=330:duration=5", "-c:a", "libmp3lame", "-b:a", "64k", mp3Path]);
    const mp3 = await readFile(mp3Path);
    fixtures = createServer((req, res) => {
      const show = req.url?.match(/^\/(\w+)\.xml/)?.[1];
      if (show) {
        res.writeHead(200, { "content-type": "application/rss+xml" });
        res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>${show} show</title>
          <item><title>${show} episode</title><guid>${show}-1</guid><pubDate>Wed, 21 Oct 2026 10:00:00 GMT</pubDate>
          <enclosure url="${baseUrl}/${show}.mp3" type="audio/mpeg"/></item></channel></rss>`);
      } else if (req.url?.endsWith(".mp3")) {
        res.writeHead(200, { "content-type": "audio/mpeg", "content-length": String(mp3.length) });
        res.end(mp3);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => fixtures.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(fixtures.address() as { port: number }).port}`;
    ctx.showSearch = new FixedShowSearch([
      { title: "Browsed", author: null, feed_url: `${baseUrl}/browsed.xml`, artwork_url: null, site_url: null, episode_count: 1, genres: [], source: "itunes" },
      { title: "Followed", author: null, feed_url: `${baseUrl}/followed.xml`, artwork_url: null, site_url: null, episode_count: 1, genres: [], source: "itunes" },
      { title: "Elsewhere", author: null, feed_url: `${baseUrl}/elsewhere.xml`, artwork_url: null, site_url: null, episode_count: 1, genres: [], source: "itunes" },
    ]);
    app = await buildApp(ctx);
    token = (await app.inject({ method: "POST", url: "/v1/devices", payload: { name: "test", platform: "ios", password: "hunter2" } })).json().token;
  });

  afterAll(async () => {
    await app.close();
    fixtures.close();
  });

  let browsedId: string;
  let followedId: string;
  let episodeId: string;

  it("is created manual and refreshed once, whatever processing was asked for", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/feeds", headers: auth(), payload: { url: `${baseUrl}/browsed.xml`, followed: false, auto_process: true, backfill: 5 } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ followed: false, auto_process: false, backfill: 0, last_refresh_at: null });
    browsedId = res.json().id;
    followedId = (await app.inject({ method: "POST", url: "/v1/feeds", headers: auth(), payload: { url: `${baseUrl}/followed.xml`, auto_process: false, backfill: 0 } })).json().id;
    await drain(ctx, { kinds: ["refresh_feed"] });
    const feed = (await app.inject({ method: "GET", url: `/v1/feeds/${browsedId}`, headers: auth() })).json();
    expect(feed.last_refresh_at).not.toBeNull();
    expect(feed.episode_count).toBe(1);
    expect(transcriber.calls).toHaveLength(0);
  });

  it("is listed with its flag, and can be filtered out", async () => {
    const all = (await app.inject({ method: "GET", url: "/v1/feeds", headers: auth() })).json() as { id: string; followed: boolean }[];
    expect(all.find((f) => f.id === browsedId)?.followed).toBe(false);
    expect(all.find((f) => f.id === followedId)?.followed).toBe(true);
    const followed = (await app.inject({ method: "GET", url: "/v1/feeds?followed=true", headers: auth() })).json() as { id: string }[];
    expect(followed.map((f) => f.id)).toEqual([followedId]);
  });

  it("is marked in search results, and a duplicate subscription names the existing feed", async () => {
    const results = (await app.inject({ method: "GET", url: "/v1/search/shows?q=show", headers: auth() })).json().results as { title: string; feed_id: string | null; followed: boolean | null }[];
    expect(results.map((r) => [r.title, r.feed_id, r.followed])).toEqual([
      ["Browsed", browsedId, false],
      ["Followed", followedId, true],
      ["Elsewhere", null, null],
    ]);
    const again = await app.inject({ method: "POST", url: "/v1/feeds", headers: auth(), payload: { url: `${baseUrl}/browsed.xml` } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatchObject({ code: "conflict", feed_id: browsedId });
  });

  it("lists its episodes by feed, but not among every feed's new episodes until one is in progress", async () => {
    const own = (await app.inject({ method: "GET", url: `/v1/episodes?feed_id=${browsedId}`, headers: auth() })).json();
    expect(own.items).toHaveLength(1);
    episodeId = own.items[0].id;
    const titles = async () => ((await app.inject({ method: "GET", url: "/v1/episodes", headers: auth() })).json().items as { title: string }[]).map((e) => e.title);
    expect(await titles()).toEqual(["followed episode"]);

    // Play it: the recording is fetched without transcribing, and the position makes it Continue listening.
    expect((await app.inject({ method: "POST", url: `/v1/episodes/${episodeId}/audio`, headers: auth() })).statusCode).toBe(202);
    await drain(ctx, { kinds: ["fetch_audio", "transcribe"] });
    const ep = (await app.inject({ method: "GET", url: `/v1/episodes/${episodeId}`, headers: auth() })).json();
    expect(ep.processing).toMatchObject({ audio: "ready", transcript: "none" });
    expect(transcriber.calls).toHaveLength(0);
    const put = await app.inject({ method: "PUT", url: `/v1/playback/${ep.asset_id}`, headers: auth(), payload: { position_ms: 2_000, speed: 1, playing: true, finished: false, seq: 1 } });
    expect(put.statusCode).toBe(200);
    expect((await titles()).sort()).toEqual(["browsed episode", "followed episode"]);
  });

  it("can be processed on request", async () => {
    expect((await app.inject({ method: "POST", url: `/v1/episodes/${episodeId}/process`, headers: auth() })).statusCode).toBe(202);
    await drain(ctx, { kinds: ["fetch_audio", "transcribe"] });
    expect(transcriber.calls).toHaveLength(1);
  });

  it("is skipped by scheduled and refresh-everything runs, but refreshes on request", async () => {
    expect(scheduledFeedIds(ctx)).toEqual([followedId]);
    const run = (await app.inject({ method: "POST", url: "/v1/refresh-runs", headers: auth(), payload: { key: "follow-test" } })).json();
    expect(run.jobs.map((j: { feed_id: string }) => j.feed_id)).toEqual([followedId]);
    expect((await app.inject({ method: "POST", url: `/v1/feeds/${browsedId}/refresh`, headers: auth() })).statusCode).toBe(202);
  });

  it("follows and unfollows with PATCH; unfollowing makes a show manual", async () => {
    const followed = await app.inject({ method: "PATCH", url: `/v1/feeds/${browsedId}`, headers: auth(), payload: { followed: true } });
    expect(followed.json()).toMatchObject({ followed: true, auto_process: false });
    expect(scheduledFeedIds(ctx).sort()).toEqual([browsedId, followedId].sort());
    await app.inject({ method: "PATCH", url: `/v1/feeds/${browsedId}`, headers: auth(), payload: { auto_process: true } });
    const unfollowed = await app.inject({ method: "PATCH", url: `/v1/feeds/${browsedId}`, headers: auth(), payload: { followed: false } });
    expect(unfollowed.json()).toMatchObject({ followed: false, auto_process: false, episode_count: 1 });
  });
});
