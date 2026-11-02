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
import { testContext } from "./helpers/context.js";

const execFileAsync = promisify(execFile);

class CountingTranscriber implements Transcriber {
  readonly name = "counting";
  calls: TranscribeInput[] = [];
  async transcribe(input: TranscribeInput): Promise<RawTranscript> {
    this.calls.push(input);
    return { language: "eng", words: [{ start_ms: 0, end_ms: 400, text: "Hello.", speaker: "S1" }] } as unknown as RawTranscript;
  }
}

// Opening an episode to play it fetches the recording (POST /v1/episodes/{id}/audio). Transcription is billed per
// audio hour, so for a show in manual mode that fetch must not queue it; an automatic show still transcribes.
describe("playing an episode that has no recording yet", () => {
  let fixtures: Server;
  let baseUrl: string;
  let ctx: AppContext;
  let app: FastifyInstance;
  let token: string;
  const transcriber = new CountingTranscriber();

  beforeAll(async () => {
    ctx = testContext({ transcriber });
    const mp3Path = join(ctx.paths.tmp, "fixture.mp3");
    await execFileAsync("ffmpeg", ["-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=330:duration=5", "-c:a", "libmp3lame", "-b:a", "64k", mp3Path]);
    const mp3 = await readFile(mp3Path);
    fixtures = createServer((req, res) => {
      const show = req.url?.match(/^\/(manual|auto)\.xml/)?.[1];
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
    app = await buildApp(ctx);
    token = (await app.inject({ method: "POST", url: "/v1/devices", payload: { name: "test", platform: "ios", password: "hunter2" } })).json().token;
  });

  afterAll(async () => {
    await app.close();
    fixtures.close();
  });

  const auth = () => ({ authorization: `Bearer ${token}` });

  async function playFirstEpisode(show: "manual" | "auto") {
    const feed = await app.inject({ method: "POST", url: "/v1/feeds", headers: auth(), payload: { url: `${baseUrl}/${show}.xml`, auto_process: show === "auto", backfill: 0 } });
    expect(feed.statusCode).toBe(201);
    await drain(ctx, { kinds: ["refresh_feed"] });
    const list = (await app.inject({ method: "GET", url: `/v1/episodes?feed_id=${feed.json().id}`, headers: auth() })).json();
    const episodeId = list.items[0].id as string;
    expect((await app.inject({ method: "POST", url: `/v1/episodes/${episodeId}/audio`, headers: auth() })).statusCode).toBe(202);
    await drain(ctx, { kinds: ["fetch_audio", "transcribe"] });
    return (await app.inject({ method: "GET", url: `/v1/episodes/${episodeId}`, headers: auth() })).json();
  }

  it("fetches the recording of a manual show without transcribing it", async () => {
    const ep = await playFirstEpisode("manual");
    expect(ep.asset).not.toBeNull();
    expect(ep.processing).toMatchObject({ audio: "ready", transcript: "none" });
    expect(transcriber.calls).toHaveLength(0);
  });

  it("still transcribes an automatic show", async () => {
    const before = transcriber.calls.length;
    const ep = await playFirstEpisode("auto");
    expect(ep.asset).not.toBeNull();
    expect(transcriber.calls.length - before).toBe(1);
  });
});
