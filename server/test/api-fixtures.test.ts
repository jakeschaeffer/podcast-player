/**
 * Recorded responses for the native app: one JSON file per endpoint and state in contracts/api/, each holding the
 * request, the status, and the body the server really sends. The iOS API client decodes every file in a test, so a
 * server change that breaks its models fails there.
 *
 * Ids and timestamps change on every recording, so this test compares *shapes* (keys and value types), not
 * values: it fails when a committed file no longer matches what the server returns. Re-record with
 * `pnpm --dir server api-fixtures:update` and commit the result.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Static, TSchema } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseAgainstSchema, type GenerateRequest, type GenerateResult, type TextModel } from "../src/adapters/textModel.js";
import type { AppContext } from "../src/app/context.js";
import { buildApp } from "../src/http/app.js";
import { drain } from "../src/jobs/worker.js";
import { newId } from "../src/lib/ids.js";
import { storeTranscript } from "../src/services/transcripts.js";
import { storeAdBreaks } from "../src/services/adBreaks.js";
import { FixedShowSearch } from "./helpers/context.js";
import { DURATION_MS, makeTone, PRICING, recordingFixture, transcriptAbout } from "./helpers/fixture.js";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "contracts", "api");
const UPDATE = process.env.UPDATE_API_FIXTURES === "1";

/** Valid answers for both summary prompts, picked by the schema the request carries. */
class ScriptedModel implements TextModel {
  readonly name = "scripted";
  async generate<S extends TSchema>(req: GenerateRequest<S>): Promise<GenerateResult<Static<S>>> {
    const props = (req.schema as { properties?: Record<string, unknown> }).properties ?? {};
    const data =
      "preview" in props
        ? {
            preview: "The guest explains why a flat monthly fee failed and what replaced it.",
            takeaways: [{ text: "A flat fee left money on the table.", sentence_id: 0 }],
            chapters: [{ start_sentence_id: 0, title: "Why the flat fee failed", description: "Nobody upgraded for three months.", kind: "content" }],
          }
        : { title: "A flat fee nobody upgraded from", bullets: [{ text: "Nobody upgrades for three months.", sentence_ids: [0] }, { text: "A flat fee feels simple and fair.", sentence_ids: [0] }], quote: "" };
    return { data: parseAgainstSchema(req.schema, data), model: "scripted", elapsed_ms: 0 };
  }
}

type Recorded = { request: { method: string; url: string; body?: unknown }; status: number; body: unknown };
const recorded = new Map<string, Recorded>();

let app: FastifyInstance;
let ctx: AppContext;
let clock: { now: number };
let token: string;

async function record(name: string, opts: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; url: string; body?: Record<string, unknown>; auth?: boolean }): Promise<Recorded> {
  const res = await app.inject({ method: opts.method, url: opts.url, ...(opts.body ? { payload: opts.body } : {}), headers: opts.auth === false ? {} : { authorization: `Bearer ${token}` } });
  const body = res.body.length > 0 && String(res.headers["content-type"]).includes("json") ? res.json() : null;
  const entry: Recorded = { request: { method: opts.method, url: opts.url, ...(opts.body ? { body: opts.body } : {}) }, status: res.statusCode, body };
  recorded.set(name, entry);
  return entry;
}

/** Keys and value types, recursively; arrays by their first element. */
function shape(v: unknown): unknown {
  if (v === null) return "null";
  if (Array.isArray(v)) return v.length === 0 ? [] : [shape(v[0])];
  if (typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, shape((v as Record<string, unknown>)[k])]));
  return typeof v;
}

beforeAll(async () => {
  const mp3 = await makeTone();
  const fx = recordingFixture(mp3, { textModel: new ScriptedModel() });
  ({ ctx, clock } = fx);
  const { assetId, episodeId } = fx;
  app = await buildApp(ctx);

  // Log in. The token in the recording is a throwaway from this in-memory database.
  const login = await record("devices.create", { method: "POST", url: "/v1/devices", body: { name: "iPhone", platform: "ios", password: "hunter2" }, auth: false });
  token = (login.body as { token: string }).token;
  await record("errors.unauthorized", { method: "GET", url: "/v1/feeds", auth: false });

  // A transcribed, summarized recording with some listening on it.
  const transcript = storeTranscript(ctx, assetId, transcriptAbout(PRICING), {});
  await drain(ctx, { kinds: ["summarize_episode", "detect_ads"] });
  // The fixture's passage has no ad in it; record the shape of one so the native client decodes a real break.
  const detected = ctx.db.prepare("SELECT inputs FROM ad_detection WHERE audio_asset_id = ?").pluck().get(assetId) as string;
  storeAdBreaks(ctx, assetId, JSON.parse(detected), [{ start_ms: 30_000, end_ms: 62_400, confidence: "high", sources: ["publisher_gap", "sponsor_phrase"], cue: "this episode is brought to you by" }]);
  await record("playback.report", { method: "PUT", url: `/v1/playback/${assetId}`, body: { position_ms: 95_000, speed: 1.25, playing: true, finished: false, seq: 1, observed_at: clock.now - 1000 } });
  await record("queue.list", { method: "GET", url: "/v1/queue" });
  const feedId = ctx.db.prepare("SELECT feed_id FROM episode WHERE id = ?").pluck().get(episodeId) as string;
  await record("feeds.list", { method: "GET", url: "/v1/feeds" });
  await record("feeds.get", { method: "GET", url: `/v1/feeds/${feedId}` });

  // Finding a show and opening it without following it (the native app's search): manual, out of the library.
  const found = { author: "The New York Times", artwork_url: "https://example.com/art.jpg", site_url: "https://example.com/show", episode_count: 210, genres: ["Technology"], source: "itunes" as const };
  ctx.showSearch = new FixedShowSearch([
    { ...found, title: "Hard Fork", feed_url: "https://feeds.example.com/hardfork.xml" },
    { ...found, title: "The Daily", feed_url: "https://feeds.example.com/thedaily.xml", site_url: null, artwork_url: null, episode_count: null, genres: [] },
  ]);
  await record("feeds.create", { method: "POST", url: "/v1/feeds", body: { url: "https://feeds.example.com/hardfork.xml", auto_process: false, backfill: 0, followed: false } });
  await record("search.shows", { method: "GET", url: "/v1/search/shows?q=hard%20fork&limit=20" });
  await record("errors.conflict.feed", { method: "POST", url: "/v1/feeds", body: { url: "https://feeds.example.com/hardfork.xml" } });
  await record("episodes.list", { method: "GET", url: "/v1/episodes?limit=30" });
  await record("episodes.get", { method: "GET", url: `/v1/episodes/${episodeId}` });
  await record("transcripts.get", { method: "GET", url: `/v1/transcripts/${transcript.id}` });

  // A snip through its states.
  const created = await record("snips.create", { method: "POST", url: "/v1/snips", body: { client_request_id: "01EXAMPLE0000000000000001", asset_id: assetId, anchor_ms: 100_000, heard_from_ms: 0, captured_at: clock.now - 500 } });
  const snipId = (created.body as { id: string }).id;
  await drain(ctx, { kinds: ["select_snip", "render_clip", "summarize_snip"] });
  const ready = await record("snips.get.ready", { method: "GET", url: `/v1/snips/${snipId}` });
  const rev1 = (ready.body as { revision: { id: string } }).revision.id;
  await record("errors.bad_request", { method: "PATCH", url: `/v1/snips/${snipId}`, body: { start_ms: 40_000, end_ms: 90_000 } });
  await record("snips.edit", { method: "PATCH", url: `/v1/snips/${snipId}`, body: { start_ms: 40_000, end_ms: 90_000, if_revision: rev1, title: "Flat fees left money on the table" } });
  await record("errors.conflict", { method: "PATCH", url: `/v1/snips/${snipId}`, body: { start_ms: 41_000, end_ms: 90_000, if_revision: rev1 } });
  await drain(ctx, { kinds: ["render_clip", "summarize_snip"] });
  await record("snips.list", { method: "GET", url: "/v1/snips?limit=30" });

  // Sharing, and what a recipient's link returns (a native app renders universal links from these).
  const share = await record("episodes.share.create", { method: "POST", url: `/v1/episodes/${episodeId}/share` });
  await record("episodes.share.get", { method: "GET", url: `/v1/episodes/${episodeId}/share` });
  const snipToken = String((ready.body as { share_url: string }).share_url.split("/s/")[1]);
  await record("public.snip", { method: "GET", url: `/s/${snipToken}.json`, auth: false });
  await record("public.episode", { method: "GET", url: `${new URL((share.body as { share_url: string }).share_url).pathname}.json`, auth: false });

  // A snip on a recording with no transcript yet: it waits.
  const otherEpisode = newId();
  const otherAsset = newId();
  ctx.db.prepare("INSERT INTO episode (id, feed_id, guid, title, first_seen_at, enclosure_url_enc) VALUES (?, ?, 'g2', 'Untranscribed', ?, ?)").run(otherEpisode, feedId, clock.now, Buffer.from("x"));
  ctx.db.prepare("INSERT INTO audio_asset (id, episode_id, sha256, bytes, duration_ms, mime, path, created_at) VALUES (?, ?, ?, 1, ?, 'audio/mpeg', ?, ?)").run(otherAsset, otherEpisode, otherAsset, DURATION_MS, mp3, clock.now);
  ctx.db.prepare("UPDATE episode SET current_asset_id = ? WHERE id = ?").run(otherAsset, otherEpisode);
  await record("snips.create.waiting", { method: "POST", url: "/v1/snips", body: { client_request_id: "01EXAMPLE0000000000000002", asset_id: otherAsset, anchor_ms: 60_000, heard_from_ms: 0 } });

  // A snip whose clip can never be rendered: it fails.
  const doomed = await record("snips.create.selecting", { method: "POST", url: "/v1/snips", body: { client_request_id: "01EXAMPLE0000000000000003", asset_id: assetId, anchor_ms: 110_000, heard_from_ms: 0 } });
  const doomedId = (doomed.body as { id: string }).id;
  await drain(ctx, { kinds: ["select_snip"] });
  ctx.db.prepare("UPDATE audio_asset SET path = '/nonexistent/recording.mp3' WHERE id = ?").run(assetId);
  for (let round = 0; round < 10; round++) {
    await drain(ctx, { kinds: ["render_clip", "summarize_snip"] });
    clock.now += 2 * 3600 * 1000;
  }
  await record("snips.get.failed", { method: "GET", url: `/v1/snips/${doomedId}` });
  await record("jobs.list", { method: "GET", url: "/v1/jobs" });
  await record("health", { method: "GET", url: "/v1/health" });

  // The Prompts screen, on the repository's own prompts. Only reads and a queued (never drained) run: saving or
  // activating a version would commit to the checkout's git. Run results are gitignored, so one finished titles
  // run is written to a scratch EVALS_DIR to give the recordings a score and cases.
  const evalsDir = mkdtempSync(join(tmpdir(), "pp-fixture-evals-"));
  mkdirSync(join(evalsDir, "snip-titles", "results"), { recursive: true });
  const titleRow = { show: "Pricing Talk", reference: "Flat fee, nobody upgraded", failed: null, missing: "nothing" };
  writeFileSync(
    join(evalsDir, "snip-titles", "results", "2026-10-20T12-00-00-titles.json"),
    JSON.stringify({ meta: { prompt: "v2", run_at: "2026-10-20T12:00:00.000Z" }, rows: [
      { ...titleRow, id: "rw-1", candidate: "A flat fee nobody upgraded from", score: 5 },
      { ...titleRow, id: "rw-2", candidate: "Why pricing is hard", score: 2, missing: "That nobody upgraded." },
    ] }),
  );
  const previousEvalsDir = process.env.EVALS_DIR;
  process.env.EVALS_DIR = evalsDir;
  try {
    await record("evals.runs.create", { method: "POST", url: "/v1/evals/titles/runs", body: { version: "v2" } });
    await record("prompts.list", { method: "GET", url: "/v1/prompts" });
    await record("prompts.version.get", { method: "GET", url: "/v1/prompts/snip-summary/versions/v2" });
    await record("evals.runs.get", { method: "GET", url: "/v1/evals/titles/runs/2026-10-20T12-00-00" });
  } finally {
    if (previousEvalsDir === undefined) delete process.env.EVALS_DIR;
    else process.env.EVALS_DIR = previousEvalsDir;
  }
});

afterAll(async () => {
  await app.close();
});

describe("recorded API responses for the native app", () => {
  it("records every state it means to", () => {
    expect((recorded.get("episodes.get")!.body as { summary: unknown }).summary).not.toBeNull();
    expect((recorded.get("snips.get.ready")!.body as { revision: { status: string } }).revision.status).toBe("ready");
    expect((recorded.get("snips.create.waiting")!.body as { revision: { status: string } }).revision.status).toBe("waiting");
    expect((recorded.get("snips.get.failed")!.body as { revision: { status: string } }).revision.status).toBe("failed");
    expect(recorded.get("errors.conflict")!.status).toBe(409);
    expect(recorded.get("errors.bad_request")!.status).toBe(400);
    expect(recorded.get("errors.unauthorized")!.status).toBe(401);
    const version = recorded.get("prompts.version.get")!.body as { previous: unknown; runs: { status: string }[] };
    expect(version.previous).not.toBeNull();
    expect(version.runs.map((r) => r.status)).toEqual(["queued", "done"]);
    expect(recorded.get("evals.runs.create")!.status).toBe(202);
  });

  it("matches the committed files in shape", () => {
    if (UPDATE) {
      mkdirSync(OUT, { recursive: true });
      for (const [name, entry] of recorded) writeFileSync(join(OUT, `${name}.json`), `${JSON.stringify(entry, null, 2)}\n`);
    }
    const committed = existsSync(OUT) ? readdirSync(OUT).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort() : [];
    expect(committed, "contracts/api is out of date: run `pnpm --dir server api-fixtures:update`").toEqual([...recorded.keys()].sort());
    for (const [name, entry] of recorded) {
      const file = JSON.parse(readFileSync(join(OUT, `${name}.json`), "utf8")) as Recorded;
      expect(shape(file), `contracts/api/${name}.json no longer matches the server: run \`pnpm --dir server api-fixtures:update\``).toEqual(shape(entry));
    }
  });
});
