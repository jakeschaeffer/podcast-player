/**
 * The owner's own words on a snip (title, note, summary bullets) at every step of its pipeline, and what each later
 * step (the selector, an episode map's passage title, the clip, the summary job, a boundary edit) does to them.
 */
import type { Static, TSchema } from "@sinclair/typebox";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parseAgainstSchema, type GenerateRequest, type GenerateResult, type TextModel } from "../src/adapters/textModel.js";
import type { AppContext } from "../src/app/context.js";
import type { SnipRevisionRow } from "../src/db/rows.js";
import { buildApp } from "../src/http/app.js";
import type { JobKind } from "../src/jobs/queue.js";
import { drain } from "../src/jobs/worker.js";
import { newId } from "../src/lib/ids.js";
import { queueEpisodeMap } from "../src/services/episodeMaps.js";
import { createSnip, editSnip, getSnip, type OwnerEdit } from "../src/services/snips.js";
import { storeTranscript } from "../src/services/transcripts.js";
import { makeTone, PRICING, recordingFixture, transcriptAbout } from "./helpers/fixture.js";

const MODEL_TITLE = "Usage pricing doubled revenue";
const MODEL_BULLET = "Switching to usage based pricing doubles revenue.";
const VALID = { title: MODEL_TITLE, bullets: [{ text: MODEL_BULLET, sentence_ids: [0] }], quote: "" };

/**
 * Answers summaries with VALID and episode maps with a passage at every third sentence; `down` makes every summary
 * request fail as an unreachable model would.
 */
class FakeModel implements TextModel {
  readonly name = "fake";
  summaries = 0;
  down = false;
  async generate<S extends TSchema>(req: GenerateRequest<S>): Promise<GenerateResult<Static<S>>> {
    const props = (req.schema as { properties?: Record<string, unknown> }).properties ?? {};
    if ("thoughts" in props) {
      const ids = [...req.user.matchAll(/^\[(\d+)\] /gm)].map((m) => Number(m[1])).filter((id) => id % 3 === 0);
      const thoughts = ids.map((start_id) => ({ start_id, title: `Passage ${start_id}`, major: start_id === 0, needs_start: true }));
      return { data: parseAgainstSchema(req.schema, { thoughts }), model: "fake-map", elapsed_ms: 1 };
    }
    this.summaries++;
    if (this.down) throw new Error("ECONNRESET");
    return { data: parseAgainstSchema(req.schema, VALID), model: "fake-model", elapsed_ms: 1 };
  }
}

const PIPELINE: JobKind[] = ["select_snip", "render_clip", "summarize_snip"];

let mp3: string;
beforeAll(async () => {
  mp3 = await makeTone();
});

function setup(opts: { transcript?: boolean; maps?: boolean } = {}) {
  const model = new FakeModel();
  const fx = recordingFixture(mp3, { textModel: model });
  if (opts.maps) fx.ctx.config.episodeMaps = true;
  if (opts.transcript !== false) storeTranscript(fx.ctx, fx.assetId, transcriptAbout(PRICING), {});
  const snipAt = (owner?: OwnerEdit) => createSnip(fx.ctx, { client_request_id: newId(), asset_id: fx.assetId, anchor_ms: 100_000, heard_from_ms: 0, ...(owner ? { owner } : {}) }, null).snip.id;
  const revision = (snipId: string) =>
    fx.ctx.db.prepare("SELECT r.* FROM snip_revision r JOIN snip s ON s.current_revision_id = r.id WHERE s.id = ?").get(snipId) as SnipRevisionRow;
  const note = (snipId: string) => fx.ctx.db.prepare("SELECT note FROM snip WHERE id = ?").pluck().get(snipId) as string | null;
  return { ...fx, model, snipAt, revision, note };
}

/** The owner's three edits, in place, as the app sends them: no if_revision. */
const ownerWords = (ctx: AppContext, snipId: string, tag: string) =>
  editSnip(ctx, snipId, { title: `My title ${tag}`, note: `My note ${tag}`, summary: `My point ${tag}\nAnother point` }, null);

describe("the owner's title, note and summary at every step", () => {
  it("while the recording waits for a transcript, and through the selector, clip and summary that follow", async () => {
    const { ctx, assetId, model, snipAt, revision, note } = setup({ transcript: false });
    const id = snipAt();
    await drain(ctx, { kinds: ["select_snip"] }); // defers: no transcript yet
    expect(revision(id).status).toBe("waiting");
    const view = ownerWords(ctx, id, "waiting");
    expect(view.note).toBe("My note waiting");
    expect(view.revision).toMatchObject({ rev: 1, status: "waiting", title: "My title waiting", title_source: "owner", summary: "My point waiting\nAnother point", summary_source: "owner" });

    storeTranscript(ctx, assetId, transcriptAbout(PRICING), {});
    await drain(ctx, { kinds: PIPELINE });
    expect(model.summaries).toBe(1); // the model still writes for the span: its words are kept beside the owner's
    expect(revision(id)).toMatchObject({
      rev: 1, status: "ready", summary_status: "ready",
      title: "My title waiting", title_source: "owner", generated_title: MODEL_TITLE,
      summary: "My point waiting\nAnother point", summary_source: "owner", generated_summary: MODEL_BULLET,
    });
    expect(note(id)).toBe("My note waiting");
  });

  it("while the selector has not chosen yet, and over an episode map's passage title", async () => {
    const { ctx, assetId, snipAt, revision } = setup({ maps: true });
    const transcriptId = ctx.db.prepare("SELECT transcript_id FROM audio_asset WHERE id = ?").pluck().get(assetId) as string;
    queueEpisodeMap(ctx, transcriptId);
    await drain(ctx, { kinds: ["map_episode"] });

    const plain = snipAt();
    const owned = snipAt();
    expect(revision(owned).status).toBe("selecting");
    ownerWords(ctx, owned, "selecting");
    await drain(ctx, { kinds: ["select_snip"] });
    expect(revision(plain)).toMatchObject({ method: "map", title_source: "map" }); // the map is in play
    expect(revision(owned)).toMatchObject({ method: "map", status: "preparing", title: "My title selecting", title_source: "owner", summary_source: "owner" });

    await drain(ctx, { kinds: ["render_clip", "summarize_snip"] });
    expect(revision(plain)).toMatchObject({ title: MODEL_TITLE, title_source: "model", summary: MODEL_BULLET, summary_source: "model" });
    expect(revision(owned)).toMatchObject({ status: "ready", title: "My title selecting", title_source: "owner", summary: "My point selecting\nAnother point", summary_source: "owner" });
  });

  it("while the clip and summary are being prepared, however late the model answers", async () => {
    const { ctx, snipAt, revision, note } = setup();
    const id = snipAt();
    await drain(ctx, { kinds: ["select_snip"] });
    expect(revision(id).status).toBe("preparing");
    ownerWords(ctx, id, "preparing");
    await drain(ctx, { kinds: ["render_clip", "summarize_snip"] });
    expect(revision(id)).toMatchObject({ status: "ready", title: "My title preparing", title_source: "owner", summary: "My point preparing\nAnother point", summary_source: "owner", generated_summary: MODEL_BULLET });
    expect(note(id)).toBe("My note preparing");
  });

  it("once ready", async () => {
    const { ctx, snipAt, revision } = setup();
    const id = snipAt();
    await drain(ctx, { kinds: PIPELINE });
    expect(revision(id)).toMatchObject({ status: "ready", summary: MODEL_BULLET, summary_source: "model", generated_summary: MODEL_BULLET });
    const view = ownerWords(ctx, id, "ready");
    expect(view.revision).toMatchObject({ rev: 1, title: "My title ready", title_source: "owner", summary: "My point ready\nAnother point", summary_source: "owner" });
    expect(view.note).toBe("My note ready");
  });

  it("after the summary model failed for good, and on a snip whose clip could never be made", async () => {
    const { ctx, clock, assetId, model, snipAt, revision } = setup();
    model.down = true;
    const id = snipAt();
    await drain(ctx, { kinds: ["select_snip", "render_clip"] });
    ownerWords(ctx, id, "model down");
    for (let i = 0; i < 6; i++) {
      await drain(ctx, { kinds: ["summarize_snip"] });
      clock.now += 2 * 3600 * 1000;
    }
    expect(revision(id)).toMatchObject({ status: "ready", summary_status: "failed", title: "My title model down", title_source: "owner", summary: "My point model down\nAnother point", summary_source: "owner", generated_summary: null });

    const broken = snipAt();
    await drain(ctx, { kinds: ["select_snip"] });
    ctx.db.prepare("UPDATE audio_asset SET path = ? WHERE id = ?").run(join(tmpdir(), "missing-recording.mp3"), assetId);
    for (let i = 0; i < 8 && revision(broken).status !== "failed"; i++) {
      await drain(ctx, { kinds: ["render_clip"] });
      clock.now += 2 * 3600 * 1000;
    }
    expect(revision(broken).status).toBe("failed");
    expect(ownerWords(ctx, broken, "failed").revision).toMatchObject({ status: "failed", title: "My title failed", title_source: "owner", summary_source: "owner" });
  });
});

describe("the owner's summary", () => {
  it("is cleaned line by line, and clearing it shows the model's bullets again", async () => {
    const { ctx, snipAt, revision } = setup();
    const id = snipAt();
    await drain(ctx, { kinds: PIPELINE });
    editSnip(ctx, id, { summary: "  - First thing \n\n• Second thing\r\n   \n* third" }, null);
    expect(revision(id)).toMatchObject({ summary: "First thing\nSecond thing\nthird", summary_source: "owner", generated_summary: MODEL_BULLET });

    editSnip(ctx, id, { summary: null }, null);
    expect(revision(id)).toMatchObject({ summary: MODEL_BULLET, summary_source: "model" });
    // Only blank lines is the same as clearing it; clearing what is already the model's changes nothing.
    editSnip(ctx, id, { summary: "Mine" }, null);
    editSnip(ctx, id, { summary: " \n - \n" }, null);
    expect(revision(id)).toMatchObject({ summary: MODEL_BULLET, summary_source: "model" });
    editSnip(ctx, id, { summary: null }, null);
    expect(revision(id)).toMatchObject({ summary: MODEL_BULLET, summary_source: "model" });
  });

  it("cleared before the model has written, leaves none until it does", async () => {
    const { ctx, snipAt, revision } = setup();
    const id = snipAt();
    editSnip(ctx, id, { summary: "Mine" }, null);
    editSnip(ctx, id, { summary: null }, null);
    expect(revision(id)).toMatchObject({ summary: null, summary_source: null });
    await drain(ctx, { kinds: PIPELINE });
    expect(revision(id)).toMatchObject({ summary: MODEL_BULLET, summary_source: "model" });
  });

  it("goes with the snip to a new span, whether the model's words are kept or written again", async () => {
    const { ctx, model, snipAt, revision } = setup();
    const id = snipAt();
    await drain(ctx, { kinds: PIPELINE });
    const first = revision(id);
    editSnip(ctx, id, { summary: "Mine" }, null);
    const move = (patch: Parameters<typeof editSnip>[2]) => editSnip(ctx, id, { if_revision: revision(id).id, snap: false, ...patch }, null);

    // A small change keeps the model's words: the owner's bullets stay on top, the model's beneath.
    move({ start_ms: first.start_ms + 2_000, end_ms: first.end_ms });
    expect(revision(id)).toMatchObject({ rev: 2, summary: "Mine", summary_source: "owner", generated_summary: MODEL_BULLET, summary_status: "ready" });
    // Written again: the owner's bullets stay, and the model's come back under them.
    move({ start_ms: first.start_ms, end_ms: first.end_ms, regenerate_summary: true });
    expect(revision(id)).toMatchObject({ rev: 3, summary: "Mine", summary_source: "owner", generated_summary: null, summary_status: "pending" });
    await drain(ctx, { kinds: ["render_clip", "summarize_snip"] });
    expect(model.summaries).toBe(2);
    expect(revision(id)).toMatchObject({ rev: 3, status: "ready", summary: "Mine", summary_source: "owner", generated_summary: MODEL_BULLET });

    // A boundary edit can carry a new summary, or clear the owner's, in the same request.
    move({ start_ms: first.start_ms + 1_000, end_ms: first.end_ms, summary: "Moved and rewritten" });
    expect(revision(id)).toMatchObject({ rev: 4, summary: "Moved and rewritten", summary_source: "owner", generated_summary: MODEL_BULLET });
    move({ start_ms: first.start_ms + 2_000, end_ms: first.end_ms, summary: null });
    expect(revision(id)).toMatchObject({ rev: 5, summary: MODEL_BULLET, summary_source: "model" });
  });

  it("queues the Readwise sync, as title and note edits do, and only when it changes", async () => {
    const { ctx, snipAt } = setup();
    const id = snipAt();
    await drain(ctx, { kinds: PIPELINE });
    const queued = () => ctx.db.prepare("SELECT status FROM job WHERE key = ?").pluck().get(`sync_readwise:${id}`) as string | undefined;
    ctx.readwise = { name: "noop", create: async () => ({ highlight_id: 1 }), update: async () => "ok" as const, remove: async () => "ok" as const };
    expect(queued()).toBeUndefined();
    editSnip(ctx, id, { summary: null }, null); // already the model's: nothing changed
    expect(queued()).toBeUndefined();
    editSnip(ctx, id, { summary: "Mine" }, null);
    expect(queued()).toBe("queued");
  });
});

describe("the device's edit from offline, and an edit made since", () => {
  it("keeps a summary sent with the tap as the owner's", async () => {
    const { ctx, snipAt, revision } = setup();
    const id = snipAt({ title: "Offline title", summary: "- Typed on the train", note: " jot " });
    expect(revision(id)).toMatchObject({ summary: "Typed on the train", summary_source: "owner" });
    await drain(ctx, { kinds: PIPELINE });
    expect(revision(id)).toMatchObject({ status: "ready", title: "Offline title", title_source: "owner", summary: "Typed on the train", summary_source: "owner", generated_summary: MODEL_BULLET });
    expect(getSnip(ctx, id, null).note).toBe("jot");
  });

  it("lets a title written online before the selector ran win over the device's older one", async () => {
    const { ctx, snipAt, revision } = setup();
    const id = snipAt({ title: "Offline title" });
    editSnip(ctx, id, { title: "Newer title" }, null);
    await drain(ctx, { kinds: PIPELINE });
    expect(revision(id)).toMatchObject({ title: "Newer title", title_source: "owner" });
  });

  it("brings the device's title along when the span is moved online before the selector ran", async () => {
    const { ctx, snipAt, revision } = setup();
    const id = snipAt({ title: "Offline title", start_ms: 10_000, end_ms: 50_000 });
    editSnip(ctx, id, { start_ms: 20_000, end_ms: 60_000, if_revision: revision(id).id, snap: false }, null);
    await drain(ctx, { kinds: PIPELINE });
    expect(revision(id)).toMatchObject({ rev: 2, method: "manual", start_ms: 20_000, end_ms: 60_000, title: "Offline title", title_source: "owner", status: "ready" });
    expect(ctx.db.prepare("SELECT owner_edit FROM snip WHERE id = ?").pluck().get(id)).toBeNull();
  });

  it("keeps the device's span, title and note when an online boundary edit is refused, or its title is only spaces", async () => {
    const { ctx, snipAt, revision, note } = setup();
    const id = snipAt({ title: "Offline title", start_ms: 10_000, end_ms: 50_000, note: "kept" });
    const pending = () => JSON.parse(ctx.db.prepare("SELECT owner_edit FROM snip WHERE id = ?").pluck().get(id) as string) as OwnerEdit;
    expect(() => editSnip(ctx, id, { start_ms: 60_000, end_ms: 20_000, if_revision: revision(id).id, snap: false, note: "lost?" }, null)).toThrow(/range must satisfy/);
    expect(() => editSnip(ctx, id, { start_word: 3, if_revision: revision(id).id }, null)).toThrow(/together/);
    editSnip(ctx, id, { title: "   " }, null);
    expect(pending()).toEqual({ start_ms: 10_000, end_ms: 50_000, title: "Offline title" });
    expect(note(id)).toBe("kept");
    await drain(ctx, { kinds: PIPELINE });
    expect(revision(id)).toMatchObject({ rev: 2, start_ms: 10_000, end_ms: 50_000, title: "Offline title", title_source: "owner" });
  });
});

describe("the episode map's passage title, saved unchanged", () => {
  it("becomes the owner's, so the summary's title does not replace it, and is not logged as a rewrite", async () => {
    const { ctx, assetId, snipAt, revision } = setup({ maps: true });
    const transcriptId = ctx.db.prepare("SELECT transcript_id FROM audio_asset WHERE id = ?").pluck().get(assetId) as string;
    queueEpisodeMap(ctx, transcriptId);
    await drain(ctx, { kinds: ["map_episode"] });
    const id = snipAt();
    await drain(ctx, { kinds: ["select_snip"] });
    const standIn = revision(id);
    expect(standIn.title_source).toBe("map");
    editSnip(ctx, id, { title: ` ${standIn.title!} ` }, null);
    expect(revision(id)).toMatchObject({ title: standIn.title, title_source: "owner" });
    await drain(ctx, { kinds: ["render_clip", "summarize_snip"] });
    expect(revision(id)).toMatchObject({ status: "ready", title: standIn.title, title_source: "owner", generated_title: MODEL_TITLE });
    expect(ctx.db.prepare("SELECT COUNT(*) FROM title_edit WHERE snip_id = ?").pluck().get(id)).toBe(0);
  });
});

describe("PATCH /v1/snips/{id} with a summary", () => {
  it("takes the owner's bullets or null, says who wrote them, and refuses an oversized one", async () => {
    const { ctx, snipAt } = setup();
    const app = await buildApp(ctx);
    const token = (await app.inject({ method: "POST", url: "/v1/devices", payload: { name: "phone", platform: "ios", password: "hunter2" } })).json().token as string;
    const patch = (payload: Record<string, unknown>) => app.inject({ method: "PATCH", url: `/v1/snips/${id}`, headers: { authorization: `Bearer ${token}` }, payload });
    const id = snipAt();
    await drain(ctx, { kinds: PIPELINE });

    const res = await patch({ summary: "One\nTwo", note: "  " });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ note: null, revision: { summary: "One\nTwo", summary_source: "owner" } });
    expect((await patch({ summary: null })).json().revision).toMatchObject({ summary: MODEL_BULLET, summary_source: "model" });
    expect((await patch({ summary: "x".repeat(2001) })).statusCode).toBe(400);
    await app.close();
  });
});
