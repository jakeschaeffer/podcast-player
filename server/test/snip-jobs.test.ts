import type { Static, TSchema } from "@sinclair/typebox";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeAll, describe, expect, it } from "vitest";
import { parseAgainstSchema, type GenerateRequest, type GenerateResult, type TextModel } from "../src/adapters/textModel.js";
import type { AppContext } from "../src/app/context.js";
import type { SnipRevisionRow } from "../src/db/rows.js";
import type { JobKind } from "../src/jobs/queue.js";
import { drain } from "../src/jobs/worker.js";
import { newId } from "../src/lib/ids.js";
import { createSnip, editSnip, getSnip } from "../src/services/snips.js";
import { storeTranscript } from "../src/services/transcripts.js";
import { GARDEN, makeTone, PRICING, recordingFixture, transcriptAbout } from "./helpers/fixture.js";

const VALID = { title: "Usage pricing doubled revenue", bullets: [{ text: "Switching to usage based pricing doubles revenue.", sentence_ids: [0] }], quote: "" };

/** Answers with a valid summary, after throwing `failFirst` transport errors; remembers every prompt it saw. */
class ScriptedModel implements TextModel {
  readonly name = "scripted";
  prompts: string[] = [];
  constructor(private failFirst = 0) {}
  async generate<S extends TSchema>(req: GenerateRequest<S>): Promise<GenerateResult<Static<S>>> {
    this.prompts.push(req.user);
    if (this.prompts.length <= this.failFirst) throw new Error("ECONNRESET");
    return { data: parseAgainstSchema(req.schema, VALID), model: "scripted-model", elapsed_ms: 1 };
  }
}

let mp3: string;
beforeAll(async () => {
  mp3 = await makeTone();
});

const setup = (opts: { textModel?: TextModel } = {}) => recordingFixture(mp3, opts);

const snipAt = (ctx: AppContext, assetId: string, anchor_ms = 100_000) =>
  createSnip(ctx, { client_request_id: newId(), asset_id: assetId, anchor_ms, heard_from_ms: 0 }, null).snip;

const revision = (ctx: AppContext, snipId: string) =>
  ctx.db.prepare("SELECT r.* FROM snip_revision r JOIN snip s ON s.current_revision_id = r.id WHERE s.id = ?").get(snipId) as SnipRevisionRow;

const jobStatus = (ctx: AppContext, key: string) => ctx.db.prepare("SELECT status FROM job WHERE key = ?").pluck().get(key) as string | undefined;

/** Drain the given kinds, moving the clock past each retry's backoff, until the job with `key` is done or failed. */
async function drainUntilSettled(ctx: AppContext, clock: { now: number }, key: string, kinds: JobKind[]) {
  for (let round = 0; round < 10; round++) {
    await drain(ctx, { kinds });
    const status = jobStatus(ctx, key);
    if (status === "done" || status === "failed") return status;
    clock.now += 2 * 3600 * 1000;
  }
  throw new Error(`${key} never settled`);
}

describe("snip jobs", () => {
  it("summarizes the transcript the revision was cut from, even after a newer transcript becomes current", async () => {
    const model = new ScriptedModel();
    const { ctx, assetId } = setup({ textModel: model });
    storeTranscript(ctx, assetId, transcriptAbout(PRICING), {});
    const snip = snipAt(ctx, assetId);
    await drain(ctx, { kinds: ["select_snip"] });
    expect(revision(ctx, snip.id).excerpt).toContain("flat monthly fee");

    storeTranscript(ctx, assetId, transcriptAbout(GARDEN), {}); // e.g. aligned publisher text replaces ASR
    await drain(ctx, { kinds: ["render_clip", "summarize_snip"] });
    expect(model.prompts).toHaveLength(1);
    expect(model.prompts[0]).toContain("flat monthly fee");
    expect(model.prompts[0]).not.toContain("Tomatoes");
    expect(revision(ctx, snip.id)).toMatchObject({ status: "ready", summary_status: "ready", title: VALID.title });
  });

  it("settles on the excerpt's title at once when the model refuses us, and after a few tries when it is merely down", async () => {
    class RefusingModel implements TextModel {
      readonly name = "refusing";
      calls = 0;
      async generate<S extends TSchema>(_req: GenerateRequest<S>): Promise<GenerateResult<Static<S>>> {
        this.calls++;
        throw new Error("codex exec exited 1: Reconnecting... 2/5 (workspace routing discovery unauthorized (401))");
      }
    }
    const refusing = new RefusingModel();
    const one = setup({ textModel: refusing });
    storeTranscript(one.ctx, one.assetId, transcriptAbout(PRICING), {});
    const snip = snipAt(one.ctx, one.assetId);
    await drain(one.ctx, { kinds: ["select_snip", "render_clip", "summarize_snip"] });
    expect(refusing.calls).toBe(1);
    expect(jobStatus(one.ctx, `summarize_snip:${revision(one.ctx, snip.id).id}`)).toBe("failed");
    expect(revision(one.ctx, snip.id)).toMatchObject({ status: "ready", summary_status: "failed", title_source: "fallback" });
    expect(revision(one.ctx, snip.id).title).not.toBe("Snip");

    // Merely down: three attempts, then the same fallback, instead of the queue's five.
    const down = new ScriptedModel(99);
    const two = setup({ textModel: down });
    storeTranscript(two.ctx, two.assetId, transcriptAbout(PRICING), {});
    const snip2 = snipAt(two.ctx, two.assetId);
    await drain(two.ctx, { kinds: ["select_snip", "render_clip"] });
    const key = `summarize_snip:${revision(two.ctx, snip2.id).id}`;
    expect(await drainUntilSettled(two.ctx, two.clock, key, ["summarize_snip"])).toBe("failed");
    expect(down.prompts).toHaveLength(3);
    expect(revision(two.ctx, snip2.id)).toMatchObject({ status: "ready", summary_status: "failed", title_source: "fallback" });
  });

  it("keeps the title and summary across a small In/Out change, and writes them again when asked or after a long one", async () => {
    const model = new ScriptedModel();
    const { ctx, assetId } = setup({ textModel: model });
    storeTranscript(ctx, assetId, transcriptAbout(PRICING), {});
    const snip = snipAt(ctx, assetId);
    await drain(ctx, { kinds: ["select_snip", "render_clip", "summarize_snip"] });
    const first = revision(ctx, snip.id);
    expect(first).toMatchObject({ status: "ready", summary_status: "ready" });
    expect(first.end_ms - first.start_ms).toBeGreaterThan(25_000);
    expect(model.prompts).toHaveLength(1);
    const edit = (patch: Parameters<typeof editSnip>[2]) => editSnip(ctx, snip.id, { if_revision: revision(ctx, snip.id).id, snap: false, ...patch }, null);

    // Two seconds off the start: the clip is cut again, nothing is summarized, and the words carry over.
    edit({ start_ms: first.start_ms + 2_000, end_ms: first.end_ms });
    expect(jobStatus(ctx, `summarize_snip:${revision(ctx, snip.id).id}`)).toBeUndefined();
    await drain(ctx, { kinds: ["render_clip", "summarize_snip"] });
    expect(model.prompts).toHaveLength(1);
    expect(revision(ctx, snip.id)).toMatchObject({ rev: 2, status: "ready", summary_status: "ready", title: first.title, title_source: "model", summary: first.summary, generated_title: first.generated_title });

    // The same small change, with the owner asking for a new summary.
    edit({ start_ms: first.start_ms + 3_000, end_ms: first.end_ms, regenerate_summary: true });
    await drain(ctx, { kinds: ["render_clip", "summarize_snip"] });
    expect(model.prompts).toHaveLength(2);

    // Fifteen seconds shorter: written again by default, or kept when the owner says so.
    edit({ start_ms: first.start_ms + 15_000, end_ms: first.end_ms, regenerate_summary: false });
    await drain(ctx, { kinds: ["render_clip", "summarize_snip"] });
    expect(model.prompts).toHaveLength(2);
    expect(revision(ctx, snip.id)).toMatchObject({ rev: 4, status: "ready", summary: first.summary });
    edit({ start_ms: first.start_ms, end_ms: first.end_ms });
    await drain(ctx, { kinds: ["render_clip", "summarize_snip"] });
    expect(model.prompts).toHaveLength(3);
    expect(revision(ctx, snip.id)).toMatchObject({ rev: 5, status: "ready", summary_status: "ready" });
  });

  it("retries a summary when the model is unreachable, and keeps the model's answer once it comes back", async () => {
    const model = new ScriptedModel(2);
    const { ctx, clock, assetId } = setup({ textModel: model });
    storeTranscript(ctx, assetId, transcriptAbout(PRICING), {});
    const snip = snipAt(ctx, assetId);
    await drain(ctx, { kinds: ["select_snip", "render_clip", "summarize_snip"] });
    const rev = revision(ctx, snip.id);
    expect(rev).toMatchObject({ status: "preparing", summary_status: "pending" }); // not a permanent failure
    expect(jobStatus(ctx, `summarize_snip:${rev.id}`)).toBe("queued");

    expect(await drainUntilSettled(ctx, clock, `summarize_snip:${rev.id}`, ["summarize_snip"])).toBe("done");
    expect(model.prompts).toHaveLength(3);
    expect(revision(ctx, snip.id)).toMatchObject({ status: "ready", summary_status: "ready", title: VALID.title, title_source: "model" });
  });

  it("publishes with the fallback title when the model stays unreachable through every retry", async () => {
    const model = new ScriptedModel(Number.POSITIVE_INFINITY);
    const { ctx, clock, assetId } = setup({ textModel: model });
    storeTranscript(ctx, assetId, transcriptAbout(PRICING), {});
    const snip = snipAt(ctx, assetId);
    await drain(ctx, { kinds: ["select_snip", "render_clip"] });
    const rev = revision(ctx, snip.id);

    expect(await drainUntilSettled(ctx, clock, `summarize_snip:${rev.id}`, ["summarize_snip"])).toBe("failed");
    const after = revision(ctx, snip.id);
    expect(after).toMatchObject({ status: "ready", summary_status: "failed", title_source: "fallback", summary: null });
    expect(after.title).toBe(`${after.excerpt!.split(/\s+/).slice(0, 8).join(" ")}…`); // first eight words of the excerpt
    expect(after.error).toMatch(/^summary model unavailable: /);
  });

  it("marks the revision failed when its clip can never be rendered", async () => {
    const { ctx, clock, assetId } = setup();
    storeTranscript(ctx, assetId, transcriptAbout(PRICING), {});
    const snip = snipAt(ctx, assetId);
    await drain(ctx, { kinds: ["select_snip"] });
    ctx.db.prepare("UPDATE audio_asset SET path = ? WHERE id = ?").run(join(tmpdir(), "missing-recording.mp3"), assetId);
    const rev = revision(ctx, snip.id);

    expect(await drainUntilSettled(ctx, clock, `render_clip:${rev.id}`, ["render_clip", "summarize_snip"])).toBe("failed");
    const after = revision(ctx, snip.id);
    expect(after.status).toBe("failed");
    expect(after.error).toMatch(/^render_clip failed: /);
    expect(getSnip(ctx, snip.id, null).revision?.status).toBe("failed");
  });

  it("summarizes a span edited before the recording had a transcript, once the transcript lands", async () => {
    const { ctx, assetId } = setup();
    const snip = snipAt(ctx, assetId);
    editSnip(ctx, snip.id, { start_ms: 20_000, end_ms: 60_000, if_revision: snip.revision!.id }, null);
    await drain(ctx, { kinds: ["render_clip", "summarize_snip"] });
    expect(revision(ctx, snip.id)).toMatchObject({ rev: 2, status: "ready", summary_status: "skipped", start_word: null, title: "Snip" });

    const model = new ScriptedModel();
    ctx.textModel = model;
    storeTranscript(ctx, assetId, transcriptAbout(PRICING), {});
    await drain(ctx, { kinds: ["summarize_snip"] });
    const after = revision(ctx, snip.id);
    expect(after).toMatchObject({ rev: 2, start_ms: 20_000, end_ms: 60_000, status: "ready", summary_status: "ready", title: VALID.title, title_source: "model" });
    expect(after.start_word).not.toBeNull();
    expect(after.excerpt).toContain("flat monthly fee");
    expect(model.prompts).toHaveLength(1);
  });

  it("without a text model, replaces the placeholder title with an excerpt title once words exist", async () => {
    const { ctx, assetId } = setup();
    const snip = snipAt(ctx, assetId);
    editSnip(ctx, snip.id, { start_ms: 20_000, end_ms: 60_000, if_revision: snip.revision!.id }, null);
    await drain(ctx, { kinds: ["render_clip", "summarize_snip"] });
    storeTranscript(ctx, assetId, transcriptAbout(PRICING), {});
    await drain(ctx, { kinds: ["summarize_snip"] });
    expect(revision(ctx, snip.id)).toMatchObject({ summary_status: "skipped", title_source: "fallback" });
    expect(revision(ctx, snip.id).title).not.toBe("Snip");
  });
});
