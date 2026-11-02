import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TranscribeInput, Transcriber } from "../src/adapters/transcriber.js";
import type { ForcedAligner, ForcedAlignmentResult } from "../src/adapters/forcedAlignment.js";
import type { RawTranscript, RawWord } from "../src/core/transcript/types.js";
import type { Static, TSchema } from "@sinclair/typebox";
import { parseAgainstSchema, type GenerateRequest, type GenerateResult, type TextModel } from "../src/adapters/textModel.js";
import { buildApp } from "../src/http/app.js";
import { drain } from "../src/jobs/worker.js";
import type { AppContext } from "../src/app/context.js";
import { testContext } from "./helpers/context.js";

const execFileAsync = promisify(execFile);

/** Deterministic transcript: a two-speaker conversation laid over the whole file at 2.5 words/second. */
class FakeTranscriber implements Transcriber {
  readonly name = "fake";
  calls: TranscribeInput[] = [];
  async transcribe(input: TranscribeInput): Promise<RawTranscript> {
    this.calls.push(input);
    const script = [
      ["A", "Welcome back to the show. Today we talk about pricing."],
      ["A", "So what did you try first?"],
      ["B", "The first thing we tried was a flat monthly fee for everyone. It felt simple and fair. We ran it for three months and almost nobody upgraded. The problem was that heavy users paid the same as light users. We were leaving money on the table and did not know it."],
      ["A", "Right."],
      ["B", "So we switched to usage based pricing and revenue doubled in a quarter. That was the moment we understood the product."],
      ["A", "That is a great example. Let us take a quick break."],
    ] as const;
    const words: RawWord[] = [];
    let t = 500;
    for (const [spk, text] of script) {
      t += 800;
      for (const w of text.split(" ")) {
        words.push({ text: w, start_ms: t, end_ms: t + 340, speaker: `speaker_${spk}` });
        t += 400;
        if (/[.?!]$/.test(w)) t += 300;
      }
    }
    // Repeat the conversation until the file is covered so any anchor has words before it.
    const block = words.length;
    const span = t;
    let copy = 1;
    while (words[words.length - 1]!.end_ms < input.duration_ms - span) {
      for (let i = 0; i < block; i++) {
        const w = words[i]!;
        words.push({ ...w, start_ms: w.start_ms + span * copy, end_ms: w.end_ms + span * copy });
      }
      copy++;
    }
    return { provider: "fake", model: "script", language: "eng", words: words.filter((w) => w.end_ms <= input.duration_ms), events: [], duration_ms: input.duration_ms, cost_cents: 1 };
  }
}

/** Spreads the given text evenly over the recording, like a perfect aligner would on a perfect reading. */
class FakeAligner implements ForcedAligner {
  readonly name = "fake";
  calls = 0;
  async align(input: { duration_ms: number; text: string }): Promise<ForcedAlignmentResult> {
    this.calls++;
    const tokens = input.text.split(/\s+/).filter(Boolean);
    const step = Math.floor((input.duration_ms - 2000) / Math.max(1, tokens.length));
    return { words: tokens.map((t, i) => ({ text: t, start_ms: 1000 + i * step, end_ms: 1000 + i * step + Math.min(300, step - 10), loss: 0.2 })), loss: 0.2, cost_cents: 1, elapsed_ms: 5 };
  }
}

/** Answers every snip-summary request with the same valid title and summary. */
class FixedTitleModel implements TextModel {
  readonly name = "fixed";
  calls = 0;
  async generate<S extends TSchema>(req: GenerateRequest<S>): Promise<GenerateResult<Static<S>>> {
    this.calls++;
    const data = { title: "Usage pricing doubled revenue", bullets: [{ text: "Switching to usage based pricing doubles revenue.", sentence_ids: [0] }], quote: "" };
    return { data: parseAgainstSchema(req.schema, data), model: "fixed-model", elapsed_ms: 1 };
  }
}

describe("end to end: feed → audio → transcript → snip → public page", () => {
  let fixtures: Server;
  let baseUrl: string;
  let ctx: AppContext;
  let app: FastifyInstance;
  let token: string;
  let mp3: Buffer;
  const transcriber = new FakeTranscriber();
  const aligner = new FakeAligner();

  beforeAll(async () => {
    ctx = testContext({ transcriber, aligner });
    const mp3Path = join(ctx.paths.tmp, "fixture.mp3");
    await execFileAsync("ffmpeg", ["-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=330:duration=240", "-c:a", "libmp3lame", "-b:a", "64k", mp3Path]);
    mp3 = await readFile(mp3Path);
    fixtures = createServer((req, res) => {
      if (req.url?.startsWith("/feed.xml")) {
        res.writeHead(200, { "content-type": "application/rss+xml", etag: '"v1"' });
        res.end(feedXml(baseUrl));
      } else if (req.url?.startsWith("/articles.xml")) {
        res.writeHead(200, { "content-type": "application/rss+xml" });
        res.end(textFeedXml());
      } else if (req.url?.startsWith("/redirect")) {
        res.writeHead(302, { location: `${baseUrl}/ep1.mp3?token=secret` });
        res.end();
      } else if (req.url?.startsWith("/ep1.mp3")) {
        if (!req.url.includes("token=secret")) { res.writeHead(403); return res.end(); }
        res.writeHead(200, { "content-type": "audio/mpeg", "content-length": String(mp3.length) });
        res.end(mp3);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => fixtures.listen(0, "127.0.0.1", r));
    const addr = fixtures.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
    app = await buildApp(ctx);
    const login = await app.inject({ method: "POST", url: "/v1/devices", payload: { name: "test", platform: "cli", password: "hunter2" } });
    expect(login.statusCode).toBe(201);
    token = login.json().token;
  });

  afterAll(async () => {
    await app.close();
    fixtures.close();
  });

  const auth = () => ({ authorization: `Bearer ${token}` });
  const failures = () => ctx.db.prepare("SELECT kind, key, status, last_error FROM job WHERE last_error IS NOT NULL").all() as { kind: string; key: string; status: string; last_error: string | null }[];

  it("rejects requests without a token", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/feeds" });
    expect(res.statusCode).toBe(401);
  });

  it("marks the web cookie Secure only when the request arrived over https", async () => {
    const payload = { name: "web", platform: "web", password: "hunter2", set_cookie: true };
    const plain = await app.inject({ method: "POST", url: "/v1/devices", payload });
    const proxied = await app.inject({ method: "POST", url: "/v1/devices", payload, headers: { "x-forwarded-proto": "https" } });
    expect(String(plain.headers["set-cookie"])).toMatch(/^pp_device=/);
    expect(String(plain.headers["set-cookie"])).not.toMatch(/; Secure/);
    expect(String(proxied.headers["set-cookie"])).toMatch(/; Secure/);
  });

  let feedId: string;
  let episodeId: string;
  let assetId: string;

  it("adds a private feed, refreshes it, and backfills only the newest two episodes", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/feeds", headers: auth(), payload: { url: `${baseUrl}/feed.xml?key=private-token`, backfill: 2 } });
    expect(res.statusCode).toBe(201);
    feedId = res.json().id;
    expect(res.json().is_private).toBe(true);
    const dup = await app.inject({ method: "POST", url: "/v1/feeds", headers: auth(), payload: { url: `${baseUrl}/feed.xml?key=private-token` } });
    expect(dup.statusCode).toBe(409);

    const r1 = await drain(ctx, { kinds: ["refresh_feed"] });
    expect(r1.outcomes.done).toBe(1);
    const feed = (await app.inject({ method: "GET", url: `/v1/feeds/${feedId}`, headers: auth() })).json();
    expect(feed.title).toBe("Fixture Show");
    expect(feed.episode_count).toBe(3);
    const queued = ctx.queue.counts();
    expect(queued.queued).toBe(2); // two fetch_audio jobs, not three

    const list = (await app.inject({ method: "GET", url: `/v1/episodes?feed_id=${feedId}`, headers: auth() })).json();
    expect(list.items.map((e: { title: string }) => e.title)).toEqual(["Newest", "Middle", "Oldest"]);
    expect(list.items[0].processing.audio).toBe("queued");
    expect(list.items[2].processing.audio).toBe("none");
    // The show notes link the episode's YouTube video: remembered, and offered as a video to fetch.
    expect(list.items[0]).toMatchObject({ media_kind: "audio", youtube_id: "bJD1NpdMY5s", video: { status: "available", error: null } });
    episodeId = list.items[0].id;
  });

  it("downloads through a redirect, validates, stores, and transcribes", async () => {
    await drain(ctx, { kinds: ["fetch_audio", "transcribe", "summarize_episode"] });
    expect(failures().filter((f: { status: string }) => f.status !== "deferred")).toEqual([]);
    const ep = (await app.inject({ method: "GET", url: `/v1/episodes/${episodeId}`, headers: auth() })).json();
    expect(ep.asset).not.toBeNull();
    expect(ep.asset.duration_ms).toBeGreaterThan(239_000);
    expect(ep.transcript_id).not.toBeNull();
    expect(ep.processing).toMatchObject({ audio: "ready", transcript: "ready", summary: "deferred" }); // no text model configured
    assetId = ep.asset.id;
    expect(transcriber.calls[0]!.path).toMatch(/media\/assets\/[0-9a-f]{64}\.mp3$/);

    const audio = await app.inject({ method: "GET", url: ep.asset.audio_url.replace("http://pods.test", ""), headers: { range: "bytes=0-99" } });
    expect(audio.statusCode).toBe(206);
    expect(audio.headers["content-range"]).toBe(`bytes 0-99/${mp3.length}`);
    expect(audio.rawPayload.equals(mp3.subarray(0, 100))).toBe(true);

    const bad = await app.inject({ method: "GET", url: `/m/assets/${assetId}?e=9999999999&d=x&s=bogus` });
    expect(bad.statusCode).toBe(401);

    const transcript = (await app.inject({ method: "GET", url: `/v1/transcripts/${ep.transcript_id}`, headers: auth() })).json();
    expect(transcript.segments.length).toBeGreaterThan(5);
    expect(transcript.segments[0].words[0][2]).toBe("Welcome");
  });

  it("keeps playback state per device with a seq guard", async () => {
    const put = (seq: number, position_ms: number) => app.inject({ method: "PUT", url: `/v1/playback/${assetId}`, headers: auth(), payload: { position_ms, speed: 1.5, playing: true, finished: false, seq } });
    expect((await put(5, 120_000)).json()).toMatchObject({ accepted: true, position_ms: 120_000 });
    expect((await put(4, 90_000)).json()).toMatchObject({ accepted: false, position_ms: 120_000 });
    expect((await put(6, 90_000)).json()).toMatchObject({ accepted: true, position_ms: 90_000 }); // a rewind is respected
    const ep = (await app.inject({ method: "GET", url: `/v1/episodes/${episodeId}`, headers: auth() })).json();
    expect(ep.resume).toMatchObject({ position_ms: 90_000, device_name: "test" });
  });

  let snipId: string;
  let shareToken: string;

  it("creates a snip idempotently, selects a span, renders a clip, and publishes it", async () => {
    const body = { client_request_id: "01TESTREQUEST0000000000001", asset_id: assetId, anchor_ms: 150_000, heard_from_ms: 0 };
    const first = await app.inject({ method: "POST", url: "/v1/snips", headers: auth(), payload: body });
    expect(first.statusCode).toBe(201);
    const again = await app.inject({ method: "POST", url: "/v1/snips", headers: auth(), payload: body });
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(first.json().id);
    snipId = first.json().id;
    shareToken = first.json().share_url.split("/s/")[1];
    expect(shareToken).toMatch(/^[a-z2-7]{20}$/);
    expect(first.json().revision.status).toBe("selecting");

    const preparing = await app.inject({ method: "GET", url: `/s/${shareToken}` });
    expect(preparing.statusCode).toBe(200);
    expect(preparing.body).toContain("Preparing");

    await drain(ctx, { kinds: ["select_snip", "render_clip", "summarize_snip"] });
    expect(failures().filter((f: { status: string }) => f.status !== "deferred")).toEqual([]);
    const snip = (await app.inject({ method: "GET", url: `/v1/snips/${snipId}`, headers: auth() })).json();
    expect(snip.revision.status).toBe("ready");
    expect(snip.revision.method).toBe("snap");
    expect(snip.revision.summary_status).toBe("skipped");
    expect(snip.revision.end_ms).toBeLessThanOrEqual(150_000);
    expect(snip.revision.end_ms - snip.revision.start_ms).toBeGreaterThanOrEqual(30_000);
    expect(snip.revision.excerpt).toMatch(/\.$/);
    expect(snip.revision.title).toBeTruthy();
    expect(snip.revision.clip_url).toContain("/m/clips/");
  });

  it("serves the public page, JSON, and clip with only whitelisted fields", async () => {
    const page = await app.inject({ method: "GET", url: `/s/${shareToken}` });
    expect(page.statusCode).toBe(200);
    expect(page.headers["x-robots-tag"]).toContain("noindex");
    expect(page.body).toContain("<audio");
    expect(page.body).toContain("og:audio");
    expect(page.body).not.toContain("private-token");
    expect(page.body).toMatch(/<meta property="og:description" content="A clip from [^"]+">/);
    const image = new URL(page.body.match(/<meta property="og:image" content="([^"]+)">/)![1]!);
    expect(image.pathname).toBe(`/s/${shareToken}/og.png`);
    const png = await app.inject({ method: "GET", url: `${image.pathname}${image.search}` });
    expect(png.statusCode).toBe(200);
    expect(png.headers["content-type"]).toBe("image/png");

    const json = await app.inject({ method: "GET", url: `/s/${shareToken}.json` });
    expect(json.statusCode).toBe(200);
    expect(Object.keys(json.json()).sort()).toEqual(["clip_url", "created_at", "duration_ms", "episode", "excerpt", "quote", "rev", "show", "summary", "title", "token", "turns", "video"]);
    expect(json.json().episode.public_url).toBeNull(); // private feed: no outbound links
    expect(json.json().video).toBeNull(); // cut from a plain recording: no picture

    const clip = await app.inject({ method: "GET", url: `/s/${shareToken}/r1.mp3`, headers: { range: "bytes=0-9" } });
    expect(clip.statusCode).toBe(206);
    expect(clip.headers["cache-control"]).toContain("immutable");
    const wrongRev = await app.inject({ method: "GET", url: `/s/${shareToken}/r2.mp3` });
    expect(wrongRev.statusCode).toBe(404);
    const unknown = await app.inject({ method: "GET", url: `/s/aaaaaaaaaaaaaaaaaaaa` });
    expect(unknown.statusCode).toBe(404);
  });

  it("edits boundaries into a new revision, withdraws the old clip until the new one is ready", async () => {
    const before = (await app.inject({ method: "GET", url: `/v1/snips/${snipId}`, headers: auth() })).json();
    const stale = await app.inject({ method: "PATCH", url: `/v1/snips/${snipId}`, headers: auth(), payload: { start_ms: 100_000, end_ms: 140_000, if_revision: "01STALE0000000000000000000" } });
    expect(stale.statusCode).toBe(409);
    const edited = await app.inject({ method: "PATCH", url: `/v1/snips/${snipId}`, headers: auth(), payload: { start_ms: 100_000, end_ms: 140_000, if_revision: before.revision.id, note: "keep this" } });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().revision).toMatchObject({ rev: 2, method: "manual", status: "preparing" });
    expect(edited.json().note).toBe("keep this");

    expect((await app.inject({ method: "GET", url: `/s/${shareToken}/r1.mp3` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/s/${shareToken}` })).body).toContain("Preparing");

    await drain(ctx);
    const ready = (await app.inject({ method: "GET", url: `/v1/snips/${snipId}`, headers: auth() })).json();
    expect(ready.revision).toMatchObject({ rev: 2, status: "ready" });
    expect(Math.abs(ready.revision.clip_duration_ms - (ready.revision.end_ms - ready.revision.start_ms))).toBeLessThanOrEqual(250);
    expect((await app.inject({ method: "GET", url: `/s/${shareToken}/r2.mp3` })).statusCode).toBe(200);
    expect(ctx.db.prepare("SELECT pinned FROM audio_asset WHERE id = ?").pluck().get(assetId)).toBe(1);
  });

  it("keeps titles the owner writes and logs them with the model's title as ground truth", async () => {
    const edits = async () => (await app.inject({ method: "GET", url: "/v1/export/title-edits", headers: auth() })).json() as { new_title: string; previous_title: string | null; previous_source: string | null; generated_title: string | null; summary_model: string | null; revision_id: string; excerpt: string | null; start_ms: number; end_ms: number; show_title: string | null }[];
    expect(await edits()).toEqual([]);
    const current = (await app.inject({ method: "GET", url: `/v1/snips/${snipId}`, headers: auth() })).json();
    expect(current.revision.title_source).toBe("fallback"); // no text model in this suite: the excerpt-based title

    // The editor's Save: new In/Out points and a title in one PATCH. The summary job runs with a model this time.
    const fixed = new FixedTitleModel();
    ctx.textModel = fixed;
    try {
      const saved = await app.inject({ method: "PATCH", url: `/v1/snips/${snipId}`, headers: auth(), payload: { start_ms: 101_000, end_ms: 139_000, if_revision: current.revision.id, title: "Flat fees left money on the table" } });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().revision).toMatchObject({ rev: 3, title: "Flat fees left money on the table", title_source: "owner" });
      await drain(ctx);
    } finally {
      ctx.textModel = null;
    }
    expect(fixed.calls).toBeGreaterThan(0);
    const afterSummary = (await app.inject({ method: "GET", url: `/v1/snips/${snipId}`, headers: auth() })).json();
    expect(afterSummary.revision).toMatchObject({ rev: 3, status: "ready", title: "Flat fees left money on the table", title_source: "owner", summary: expect.stringContaining("usage based pricing") });
    let log = await edits();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ new_title: "Flat fees left money on the table", previous_title: current.revision.title, previous_source: "fallback", generated_title: "Usage pricing doubled revenue", summary_model: "fixed-model", revision_id: afterSummary.revision.id, show_title: "Fixture Show" });
    expect(log[0]!.excerpt).toBeTruthy();
    expect(log[0]!.end_ms - log[0]!.start_ms).toBeGreaterThan(30_000);

    // A later boundary edit keeps the owner's title and logs nothing new.
    const moved = await app.inject({ method: "PATCH", url: `/v1/snips/${snipId}`, headers: auth(), payload: { start_ms: 102_000, end_ms: 138_000, if_revision: afterSummary.revision.id } });
    expect(moved.json().revision).toMatchObject({ rev: 4, title: "Flat fees left money on the table", title_source: "owner" });
    await drain(ctx);
    expect((await app.inject({ method: "GET", url: `/v1/snips/${snipId}`, headers: auth() })).json().revision).toMatchObject({ rev: 4, title: "Flat fees left money on the table", title_source: "owner" });
    expect(await edits()).toHaveLength(1);

    // A title-only edit applies in place and is logged; saving the same title again is not an edit.
    const renamed = await app.inject({ method: "PATCH", url: `/v1/snips/${snipId}`, headers: auth(), payload: { title: "Heavy users paid what light users paid" } });
    expect(renamed.json().revision).toMatchObject({ rev: 4, title: "Heavy users paid what light users paid", title_source: "owner" });
    await app.inject({ method: "PATCH", url: `/v1/snips/${snipId}`, headers: auth(), payload: { title: "Heavy users paid what light users paid" } });
    log = await edits();
    expect(log).toHaveLength(2);
    expect(log[1]).toMatchObject({ new_title: "Heavy users paid what light users paid", previous_title: "Flat fees left money on the table", previous_source: "owner" });
  });

  it("shares every snip of an episode on one page, with only whitelisted fields and a nonce-locked player", async () => {
    expect((await app.inject({ method: "GET", url: `/v1/episodes/${episodeId}/share`, headers: auth() })).json()).toBeNull();
    const created = await app.inject({ method: "POST", url: `/v1/episodes/${episodeId}/share`, headers: auth() });
    expect(created.statusCode).toBe(200);
    const share = created.json() as { share_url: string; state: string; snip_count: number };
    expect(share).toMatchObject({ state: "active", snip_count: 1 });
    expect(share.share_url).toMatch(/\/e\/[a-z2-7]{20}$/);
    const again = (await app.inject({ method: "POST", url: `/v1/episodes/${episodeId}/share`, headers: auth() })).json();
    expect(again.share_url).toBe(share.share_url); // idempotent: one link per episode
    const path = new URL(share.share_url).pathname;

    const page = await app.inject({ method: "GET", url: path });
    expect(page.statusCode).toBe(200);
    expect(page.headers["x-robots-tag"]).toBe("noindex, nofollow");
    const csp = String(page.headers["content-security-policy"]);
    const nonce = csp.match(/script-src 'nonce-([^']+)'/)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toContain("default-src 'none'");
    const scripts = [...page.body.matchAll(/<script([^>]*)>/g)].map((m) => m[1]!);
    expect(scripts.every((attrs) => attrs.includes(`nonce="${nonce}"`) || attrs.includes('type="application/json"'))).toBe(true);
    const snip = (await app.inject({ method: "GET", url: `/v1/snips/${snipId}`, headers: auth() })).json();
    expect(page.body).toContain(snip.revision.title);
    expect(page.body).toContain(`/s/${shareToken}/r${snip.revision.rev}.mp3`);
    expect(page.body).toContain(`href="/s/${shareToken}"`);
    expect(page.body).not.toContain(snip.id); // no owner ids on the public side
    expect(page.body).not.toContain(assetId);

    // A pasted link: "Clips from <episode>", "N clips from <show>", and a large preview image.
    expect(page.body).toMatch(/<meta property="og:title" content="Clips from [^"]+">/);
    expect(page.body).toMatch(/<meta property="og:description" content="(1 clip|\d+ clips) from [^"]+">/);
    expect(page.body).toContain('<meta name="twitter:card" content="summary_large_image">');
    const image = new URL(page.body.match(/<meta property="og:image" content="([^"]+)">/)![1]!);
    expect(image.pathname).toBe(`${path}/og.png`);
    expect(image.searchParams.get("v")).toMatch(/^[0-9a-f]{16}$/);
    const png = await app.inject({ method: "GET", url: `${image.pathname}${image.search}` });
    expect(png.statusCode).toBe(200);
    expect(png.headers["content-type"]).toBe("image/png");
    expect(png.rawPayload.subarray(1, 4).toString()).toBe("PNG");
    expect((await app.inject({ method: "GET", url: "/e/aaaaaaaaaaaaaaaaaaaa/og.png" })).statusCode).toBe(404);

    const json = (await app.inject({ method: "GET", url: `${path}.json` })).json();
    expect(Object.keys(json).sort()).toEqual(["episode", "show", "snips"]);
    expect(Object.keys(json.snips[0]).sort()).toEqual(["clip_url", "duration_ms", "excerpt", "quote", "rev", "start_ms", "summary", "title", "token", "turns", "url", "video"]);
    expect(json.snips[0]).toMatchObject({ token: shareToken, rev: snip.revision.rev, start_ms: snip.revision.start_ms });
    expect((await app.inject({ method: "GET", url: new URL(json.snips[0].clip_url).pathname })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/e/aaaaaaaaaaaaaaaaaaaa" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/e/not-a-token" })).statusCode).toBe(404);
  });

  it("revokes stickily and deletes", async () => {
    await app.inject({ method: "POST", url: `/v1/snips/${snipId}/revoke`, headers: auth() });
    expect((await app.inject({ method: "GET", url: `/s/${shareToken}` })).statusCode).toBe(410);
    expect((await app.inject({ method: "GET", url: `/s/${shareToken}/r2.mp3` })).statusCode).toBe(410);
    const revoked = (await app.inject({ method: "GET", url: `/v1/snips/${snipId}`, headers: auth() })).json();
    await app.inject({ method: "PATCH", url: `/v1/snips/${snipId}`, headers: auth(), payload: { start_ms: 100_000, end_ms: 135_000, if_revision: revoked.revision.id } });
    await drain(ctx);
    expect((await app.inject({ method: "GET", url: `/s/${shareToken}` })).statusCode).toBe(410); // an edit never republishes
    await app.inject({ method: "POST", url: `/v1/snips/${snipId}/restore`, headers: auth() });
    expect((await app.inject({ method: "GET", url: `/s/${shareToken}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/v1/snips/${snipId}`, headers: auth() })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/s/${shareToken}` })).statusCode).toBe(410);
    expect((await app.inject({ method: "GET", url: `/v1/snips/${snipId}`, headers: auth() })).statusCode).toBe(404);
  });

  it("keeps the episode page in step with its snips, and revokes and restores the page itself", async () => {
    const share = (await app.inject({ method: "GET", url: `/v1/episodes/${episodeId}/share`, headers: auth() })).json() as { share_url: string; snip_count: number };
    expect(share.snip_count).toBe(0); // the only snip was deleted above: deleted and revoked snips drop off
    const path = new URL(share.share_url).pathname;
    const empty = await app.inject({ method: "GET", url: path });
    expect(empty.statusCode).toBe(200);
    expect(empty.body).toContain("Nothing is shared from this episode right now.");
    expect(empty.body).not.toContain(shareToken);

    expect((await app.inject({ method: "POST", url: `/v1/episodes/${episodeId}/share/revoke`, headers: auth() })).json()).toMatchObject({ state: "revoked" });
    expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(410);
    expect((await app.inject({ method: "GET", url: `${path}.json` })).statusCode).toBe(410);
    const restored = (await app.inject({ method: "POST", url: `/v1/episodes/${episodeId}/share`, headers: auth() })).json();
    expect(restored).toMatchObject({ state: "active", share_url: share.share_url }); // sharing again brings the same link back
    expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(200);
  });

  it("attaches a text feed, matches its articles to episodes, and aligns the text to the audio", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/feeds", headers: auth(), payload: { url: `${baseUrl}/articles.xml?key=t`, kind: "text", text_for_feed_id: feedId } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ kind: "text", text_for_feed_id: feedId });
    const bad = await app.inject({ method: "POST", url: "/v1/feeds", headers: auth(), payload: { url: `${baseUrl}/articles2.xml`, kind: "text" } });
    expect(bad.statusCode).toBe(400);

    await drain(ctx, { kinds: ["refresh_feed", "align_text"] });
    expect(failures().filter((f) => f.status !== "deferred")).toEqual([]);
    const texts = ctx.db.prepare("SELECT episode_id, source, kind, word_count, sections FROM episode_text").all() as { episode_id: string; source: string; kind: string; word_count: number; sections: string }[];
    expect(texts).toHaveLength(2); // "Newest" and "Middle"; the digest item matches no episode
    const newest = texts.find((t) => t.episode_id === episodeId)!;
    expect(newest).toMatchObject({ source: "rss", kind: "update" });
    expect(aligner.calls).toBe(2); // Newest and Middle both have audio from the backfill
    const sections = JSON.parse(newest.sections) as { title: string; start_ms: number | null }[];
    expect(sections.map((x) => x.title)).toEqual(["First Topic", "Second Topic"]);
    expect(sections[1]!.start_ms).toBeGreaterThan(sections[0]!.start_ms!);

    const ep = (await app.inject({ method: "GET", url: `/v1/episodes/${episodeId}`, headers: auth() })).json();
    expect(ep.text).toMatchObject({ source: "rss", kind: "update", sections: expect.arrayContaining([expect.objectContaining({ title: "First Topic" })]) });
    expect(ep.text.aligned_transcript_id).toBeTruthy();
    expect(ep.transcript_id).toBe(ep.text.aligned_transcript_id); // an Update: publisher text becomes the current transcript
    expect(ep.chapters).toMatchObject({ source: "publisher", transcript_id: ep.text.aligned_transcript_id });
    expect(ep.chapters.items.map((c: { title: string }) => c.title)).toEqual(["First Topic", "Second Topic"]);
    expect(ep.chapters.items[0].start_ms).toBe(0);
    expect(ep.chapters.items[1].end_ms).toBe(ep.asset.duration_ms);
    expect(ep.chapters.items[0].end_ms).toBe(ep.chapters.items[1].start_ms);
    const aligned = (await app.inject({ method: "GET", url: `/v1/transcripts/${ep.text.aligned_transcript_id}`, headers: auth() })).json();
    expect(aligned.segments.some((s: { spk: string | null }) => s.spk === "Greg Peters")).toBe(true); // publisher speaker names survive
    expect(aligned.segments[0].words[0][2]).toBe("On");

    // A second refresh stores nothing new and aligns nothing again.
    await app.inject({ method: "POST", url: `/v1/feeds/${res.json().id}/refresh`, headers: auth() });
    await drain(ctx, { kinds: ["refresh_feed", "align_text"] });
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM episode_text").get()).toEqual({ n: 2 });
    expect(aligner.calls).toBe(2);
  });

  it("refuses to delete a feed with snips, and publishes an OpenAPI document", async () => {
    const other = await app.inject({ method: "POST", url: "/v1/snips", headers: auth(), payload: { client_request_id: "01TESTREQUEST0000000000002", asset_id: assetId, anchor_ms: 200_000, heard_from_ms: 180_000 } });
    expect(other.statusCode).toBe(201);
    expect((await app.inject({ method: "DELETE", url: `/v1/feeds/${feedId}`, headers: auth() })).statusCode).toBe(409);
    const spec = (await app.inject({ method: "GET", url: "/v1/openapi.json", headers: auth() })).json();
    expect(spec.openapi).toBe("3.1.0");
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(["/v1/snips", "/v1/episodes/{id}", "/s/{token}", "/v1/playback/{asset_id}"]));
  });

  it("exports snips as markdown", async () => {
    const md = await app.inject({ method: "GET", url: "/v1/export/snips.md", headers: auth() });
    expect(md.statusCode).toBe(200);
    expect(md.body).toContain("## ");
    expect(md.body).toContain("http://pods.test/s/");
  });
});

function feedXml(base: string): string {
  const item = (title: string, guid: string, date: string, url: string) => `
  <item><title>${title}</title><guid>${guid}</guid><pubDate>${date}</pubDate><itunes:duration>4:00</itunes:duration>
  <description><![CDATA[<p>Notes for ${title}</p><p>Watch on <a href="https://youtu.be/bJD1NpdMY5s">YouTube</a>.</p>]]></description><enclosure url="${url}" type="audio/mpeg"/></item>`;
  return `<?xml version="1.0"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel>
  <title>Fixture Show</title><link>https://fixture.test</link><language>en</language><itunes:author>Fixture</itunes:author>
  ${item("Newest", "n1", "Wed, 21 Oct 2026 10:00:00 GMT", `${base}/redirect`)}
  ${item("Middle", "n2", "Tue, 20 Oct 2026 10:00:00 GMT", `${base}/ep1.mp3?token=secret`)}
  ${item("Oldest", "n3", "Mon, 19 Oct 2026 10:00:00 GMT", `${base}/ep1.mp3?token=secret`)}
  </channel></rss>`;
}


function textFeedXml(): string {
  const article = (title: string, guid: string, date: string, body: string) => `
  <item><title>${title}</title><guid>${guid}</guid><pubDate>${date}</pubDate><link>https://fixture.test/${guid}</link>
  <content:encoded><![CDATA[${body}]]></content:encoded></item>`;
  const update = `<p>A summary line that the podcast does not read.</p><p><a href="#">Listen to this Update in your podcast player</a></p><p>Good morning,</p>
  <p>On this week’s episode of the other show we discussed pricing.</p><p>On to the Update:</p>
  <h3>First Topic</h3><p>The first thing we tried was a flat monthly fee for everyone. It felt simple and fair.</p>
  <blockquote><p>Greg Peters: I’ll pick up this one and start with engagement.</p></blockquote>
  <h3>Second Topic</h3><p>So we switched to usage based pricing and revenue doubled in a quarter.</p>
  <p>This Update will be available as a podcast later today.</p><p>Add to your podcast player: Fixture | Other</p>`;
  return `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
  <title>Fixture Show Articles</title><link>https://fixture.test</link>
  ${article("Newest", "p=1", "Wed, 21 Oct 2026 10:00:00 GMT", update)}
  ${article("Middle", "p=2", "Tue, 20 Oct 2026 10:00:00 GMT", update)}
  ${article("Weekly Digest", "p=3", "Fri, 16 Oct 2026 10:00:00 GMT", `<p>The best content from the week.</p><p>Listen to this Update in your podcast player</p><p>Welcome back to This Week in Fixture!</p><p>Some items.</p>`)}
  </channel></rss>`;
}
