/**
 * The API contract an offline-first client (the native app's outbox) relies on: every write can be replayed after a
 * lost response without duplicating anything, and device-side times survive the delay.
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../src/app/context.js";
import { buildApp } from "../src/http/app.js";
import { drain } from "../src/jobs/worker.js";
import { storeTranscript } from "../src/services/transcripts.js";
import { GARDEN, makeTone, PRICING, recordingFixture, transcriptAbout } from "./helpers/fixture.js";

let ctx: AppContext;
let clock: { now: number };
let assetId: string;
let episodeId: string;
let app: FastifyInstance;
let token: string;
let crid = 0;

const auth = (t = token) => ({ authorization: `Bearer ${t}` });
const login = async (name: string) =>
  (await app.inject({ method: "POST", url: "/v1/devices", payload: { name, platform: "ios", password: "hunter2" } })).json().token as string;
const newSnip = async (extra: Record<string, unknown> = {}) => {
  const res = await app.inject({ method: "POST", url: "/v1/snips", headers: auth(), payload: { client_request_id: `01CONTRACT${String(++crid).padStart(16, "0")}`, asset_id: assetId, anchor_ms: 100_000, heard_from_ms: 0, ...extra } });
  expect(res.statusCode).toBe(201);
  return res.json();
};
const getSnip = async (id: string) => (await app.inject({ method: "GET", url: `/v1/snips/${id}`, headers: auth() })).json();

beforeAll(async () => {
  ({ ctx, clock, assetId, episodeId } = recordingFixture(await makeTone()));
  storeTranscript(ctx, assetId, transcriptAbout(PRICING), {});
  app = await buildApp(ctx);
  token = await login("phone");
});

afterAll(async () => {
  await app.close();
});

describe("offline-safe snip edits", () => {
  it("requires if_revision to move boundaries, so a replayed edit cannot add a second revision", async () => {
    const snip = await newSnip();
    await drain(ctx, { kinds: ["select_snip"] });
    const rev1 = (await getSnip(snip.id)).revision.id;

    const bare = await app.inject({ method: "PATCH", url: `/v1/snips/${snip.id}`, headers: auth(), payload: { start_ms: 30_000, end_ms: 70_000 } });
    expect(bare.statusCode).toBe(400);

    const edit = { start_ms: 30_000, end_ms: 70_000, if_revision: rev1 };
    const first = await app.inject({ method: "PATCH", url: `/v1/snips/${snip.id}`, headers: auth(), payload: edit });
    expect(first.statusCode).toBe(200);
    expect(first.json().revision.rev).toBe(2);
    const replay = await app.inject({ method: "PATCH", url: `/v1/snips/${snip.id}`, headers: auth(), payload: edit });
    expect(replay.statusCode).toBe(409);
    expect((await getSnip(snip.id)).revision.rev).toBe(2);

    // Title and note edits apply in place and may still omit if_revision.
    const titled = await app.inject({ method: "PATCH", url: `/v1/snips/${snip.id}`, headers: auth(), payload: { title: "Flat fees", note: "n" } });
    expect(titled.statusCode).toBe(200);
    expect(titled.json().revision.rev).toBe(2);
  });

  it("checks word edits against the transcript they index", async () => {
    const snip = await newSnip();
    await drain(ctx, { kinds: ["select_snip"] });
    const current = await getSnip(snip.id);
    const rev = current.revision;
    expect(rev.transcript_id).toMatch(/^[0-9A-Z]{26}$/);
    const patch = (body: Record<string, unknown>) => app.inject({ method: "PATCH", url: `/v1/snips/${snip.id}`, headers: auth(), payload: { if_revision: rev.id, ...body } });

    expect((await patch({ start_word: 10 })).statusCode).toBe(400); // one end alone would mix two revisions' indices
    expect((await patch({ start_word: 10, end_word: 40 })).statusCode).toBe(400); // which transcript?
    const ok = await patch({ start_word: 10, end_word: 40, transcript_id: rev.transcript_id });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().revision).toMatchObject({ start_word: 10, end_word: 40, transcript_id: rev.transcript_id });

    storeTranscript(ctx, assetId, transcriptAbout(GARDEN), {}); // the current transcript moves on
    const stale = await app.inject({ method: "PATCH", url: `/v1/snips/${snip.id}`, headers: auth(), payload: { if_revision: ok.json().revision.id, start_word: 12, end_word: 40, transcript_id: rev.transcript_id } });
    expect(stale.statusCode).toBe(409);
    storeTranscript(ctx, assetId, transcriptAbout(PRICING), {}); // leave a pricing transcript current for later tests
  });

  it("answers a replayed DELETE with 204", async () => {
    const snip = await newSnip();
    expect((await app.inject({ method: "DELETE", url: `/v1/snips/${snip.id}`, headers: auth() })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `/v1/snips/${snip.id}`, headers: auth() })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: "/v1/snips/01AAAAAAAAAAAAAAAAAAAAAAAA", headers: auth() })).statusCode).toBe(404);
  });

  it("changes the ETag when the title or note changes, and not when only the clip signature does", async () => {
    const snip = await newSnip();
    await drain(ctx, { kinds: ["select_snip", "render_clip", "summarize_snip"] });
    const read = () => app.inject({ method: "GET", url: `/v1/snips/${snip.id}`, headers: auth() });
    const tag = String((await read()).headers.etag);
    clock.now += 5_000; // the clip URL is re-signed with a later expiry
    const again = await app.inject({ method: "GET", url: `/v1/snips/${snip.id}`, headers: { ...auth(), "if-none-match": tag } });
    expect(again.statusCode).toBe(304);

    await app.inject({ method: "PATCH", url: `/v1/snips/${snip.id}`, headers: auth(), payload: { title: "A new title" } });
    const retitled = await app.inject({ method: "GET", url: `/v1/snips/${snip.id}`, headers: { ...auth(), "if-none-match": tag } });
    expect(retitled.statusCode).toBe(200);
    const tag2 = String(retitled.headers.etag);
    await app.inject({ method: "PATCH", url: `/v1/snips/${snip.id}`, headers: auth(), payload: { note: "remember this" } });
    expect(String((await read()).headers.etag)).not.toBe(tag2);
  });
});

describe("device-side times", () => {
  it("keeps when a snip was tapped, never later than it arrived", async () => {
    const past = clock.now - 3_600_000;
    expect((await newSnip({ captured_at: past })).captured_at).toBe(past);
    expect((await newSnip({ captured_at: clock.now + 3_600_000 })).captured_at).toBe(clock.now);
    const plain = await newSnip();
    expect(plain.captured_at).toBe(plain.created_at);
  });

  it("orders resume by when each position was observed, so a late replay does not win", async () => {
    const tablet = await login("tablet");
    const put = (t: string, body: Record<string, unknown>) => app.inject({ method: "PUT", url: `/v1/playback/${assetId}`, headers: auth(t), payload: { speed: 1, playing: false, finished: false, ...body } });
    const t0 = clock.now;
    // The tablet listened to 80 s five minutes ago and reported it right away.
    expect((await put(tablet, { position_ms: 80_000, seq: 1, observed_at: t0 - 300_000 })).json().accepted).toBe(true);
    // The phone was offline: its report from ten minutes ago (at 20 s) arrives only now.
    expect((await put(token, { position_ms: 20_000, seq: 1, observed_at: t0 - 600_000 })).json().accepted).toBe(true);
    const ep = (await app.inject({ method: "GET", url: `/v1/episodes/${episodeId}`, headers: auth() })).json();
    expect(ep.resume).toMatchObject({ position_ms: 80_000, device_name: "tablet", updated_at: t0 - 300_000 });

    // A clock running ahead is capped at the time the server received the report.
    await put(token, { position_ms: 30_000, seq: 2, observed_at: t0 + 86_400_000 });
    const ep2 = (await app.inject({ method: "GET", url: `/v1/episodes/${episodeId}`, headers: auth() })).json();
    expect(ep2.resume).toMatchObject({ position_ms: 30_000, device_name: "phone", updated_at: t0 });
  });
});
