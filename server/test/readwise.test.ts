import { beforeAll, describe, expect, it } from "vitest";
import { ReadwiseApi, type Readwise, type ReadwiseHighlight, type ReadwiseHighlightPatch } from "../src/adapters/readwise.js";
import type { AppContext } from "../src/app/context.js";
import type { SnipRow } from "../src/db/rows.js";
import { NonRetryable } from "../src/jobs/errors.js";
import { drain } from "../src/jobs/worker.js";
import { newId } from "../src/lib/ids.js";
import { queueReadwiseSweep, readwiseSnip } from "../src/services/readwiseSync.js";
import { highlightText, READWISE_FORMAT } from "../src/core/readwise/highlight.js";
import type { SnipRevisionRow } from "../src/db/rows.js";
import { createSnip, deleteSnip, editSnip } from "../src/services/snips.js";
import { storeTranscript } from "../src/services/transcripts.js";
import { makeTone, PRICING, recordingFixture, transcriptAbout } from "./helpers/fixture.js";
import { buildTranscript, type Turn } from "./helpers/transcript.js";

/** Readwise as a map of highlights; remembers every call. */
class FakeReadwise implements Readwise {
  readonly name = "fake";
  highlights = new Map<number, ReadwiseHighlight>();
  calls: string[] = [];
  private next = 1000;
  async create(h: ReadwiseHighlight) {
    this.calls.push("create");
    const existing = [...this.highlights].find(([, x]) => x.highlight_url === h.highlight_url);
    const id = existing?.[0] ?? this.next++;
    this.highlights.set(id, h);
    return { highlight_id: id };
  }
  async update(id: number, patch: ReadwiseHighlightPatch) {
    this.calls.push(`update ${id}`);
    const h = this.highlights.get(id);
    if (!h) return "gone" as const;
    this.highlights.set(id, { ...h, text: patch.text, note: patch.note, location: patch.location, highlight_url: patch.url });
    return "ok" as const;
  }
  async remove(id: number) {
    this.calls.push(`remove ${id}`);
    return this.highlights.delete(id) ? ("ok" as const) : ("gone" as const);
  }
}

let mp3: string;
beforeAll(async () => {
  mp3 = await makeTone();
});

const snipRow = (ctx: AppContext, id: string) => ctx.db.prepare("SELECT * FROM snip WHERE id = ?").get(id) as SnipRow;

async function readySnip(ctx: AppContext, assetId: string) {
  const snip = createSnip(ctx, { client_request_id: newId(), asset_id: assetId, anchor_ms: 100_000, heard_from_ms: 0 }, null).snip;
  await drain(ctx, { kinds: ["select_snip", "render_clip", "summarize_snip"] });
  return snip;
}

describe("Readwise sync", () => {
  it("sends a snip once it is ready, updates it on edits, and deletes it with the snip", async () => {
    const readwise = new FakeReadwise();
    const { ctx, assetId } = recordingFixture(mp3, { readwise });
    expect(queueReadwiseSweep(ctx)).toBe(0); // the worker's sweep at start
    storeTranscript(ctx, assetId, transcriptAbout(PRICING), {});
    const snip = await readySnip(ctx, assetId);
    expect(readwise.calls).toEqual([]); // queued when ready, not sent inside the snip pipeline
    await drain(ctx, { kinds: ["sync_readwise"] });
    expect(readwise.calls).toEqual(["create"]);
    const [id, h] = [...readwise.highlights][0]!;
    expect(h).toMatchObject({ title: "Pricing", author: "Fixture Show", category: "podcasts", location_type: "time_offset", highlight_url: snip.share_url });
    expect(h.text).toMatch(/\n\nTranscript:\n.*flat monthly fee/);
    expect(snipRow(ctx, snip.id)).toMatchObject({ readwise_highlight_id: id, readwise_revision_id: snip.revision!.id });

    editSnip(ctx, snip.id, { title: "Flat fees stall upgrades", note: "check the churn numbers" }, null);
    await drain(ctx, { kinds: ["sync_readwise"] });
    expect(readwise.calls).toEqual(["create", `update ${id}`]);
    expect(readwise.highlights.get(id)!.text.startsWith("Flat fees stall upgrades\n")).toBe(true);
    expect(readwise.highlights.get(id)!.note).toBe("check the churn numbers");

    // A new span is a new revision: sent when that revision is ready, to the same highlight.
    const before = snipRow(ctx, snip.id).current_revision_id!;
    editSnip(ctx, snip.id, { start_ms: 60_000, end_ms: 90_000, if_revision: before, regenerate_summary: false }, null);
    await drain(ctx, { kinds: ["render_clip", "summarize_snip", "sync_readwise"] });
    expect(readwise.calls.at(-1)).toBe(`update ${id}`);
    expect(readwise.highlights.get(id)!.location).toBe(Math.floor((await currentStart(ctx, snip.id)) / 1000));
    expect(snipRow(ctx, snip.id).readwise_revision_id).not.toBe(before);
    expect(queueReadwiseSweep(ctx)).toBe(0); // nothing is behind

    deleteSnip(ctx, snip.id);
    await drain(ctx, { kinds: ["sync_readwise"] });
    expect(readwise.calls.at(-1)).toBe(`remove ${id}`);
    expect(readwise.highlights.size).toBe(0);
    expect(snipRow(ctx, snip.id).readwise_highlight_id).toBeNull();
  });

  it("leaves a highlight the owner deleted in Readwise deleted", async () => {
    const readwise = new FakeReadwise();
    const { ctx, assetId } = recordingFixture(mp3, { readwise });
    queueReadwiseSweep(ctx);
    storeTranscript(ctx, assetId, transcriptAbout(PRICING), {});
    const snip = await readySnip(ctx, assetId);
    await drain(ctx, { kinds: ["sync_readwise"] });
    readwise.highlights.clear();
    editSnip(ctx, snip.id, { title: "A new title" }, null);
    await drain(ctx, { kinds: ["sync_readwise"] });
    expect(snipRow(ctx, snip.id).readwise_gone_at).not.toBeNull();
    editSnip(ctx, snip.id, { note: "and again" }, null);
    await drain(ctx, { kinds: ["sync_readwise"] });
    expect(readwise.calls.filter((c) => c === "create")).toHaveLength(1);
    expect(readwise.highlights.size).toBe(0);
    expect(queueReadwiseSweep(ctx)).toBe(0);
  });

  it("queues nothing without a token, and the sweep sends every ready snip made before one was set", async () => {
    const { ctx, assetId } = recordingFixture(mp3);
    storeTranscript(ctx, assetId, transcriptAbout(PRICING), {});
    const a = await readySnip(ctx, assetId);
    const b = await readySnip(ctx, assetId);
    expect(ctx.db.prepare("SELECT COUNT(*) FROM job WHERE kind = 'sync_readwise'").pluck().get()).toBe(0);
    const readwise = new FakeReadwise();
    (ctx as { readwise: Readwise | null }).readwise = readwise; // the token is set and the server restarted
    expect(queueReadwiseSweep(ctx)).toBe(2);
    await drain(ctx, { kinds: ["sync_readwise"] });
    expect(new Set([...readwise.highlights.values()].map((h) => h.highlight_url))).toEqual(new Set([a.share_url, b.share_url]));
    expect(queueReadwiseSweep(ctx)).toBe(0);
  });

  it("sends every highlight again once when the layout changes", async () => {
    const readwise = new FakeReadwise();
    const { ctx, assetId } = recordingFixture(mp3, { readwise });
    queueReadwiseSweep(ctx);
    storeTranscript(ctx, assetId, transcriptAbout(PRICING), {});
    await readySnip(ctx, assetId);
    await readySnip(ctx, assetId);
    await drain(ctx, { kinds: ["sync_readwise"] });
    expect(readwise.calls).toEqual(["create", "create"]);
    ctx.db.prepare("UPDATE setting SET value = 'old' WHERE key = 'readwise_format'").run();
    expect(queueReadwiseSweep(ctx)).toBe(2);
    await drain(ctx, { kinds: ["sync_readwise"] });
    expect(readwise.calls.slice(2).every((c) => c.startsWith("update "))).toBe(true);
    expect(readwise.calls).toHaveLength(4);
    expect(ctx.db.prepare("SELECT value FROM setting WHERE key = 'readwise_format'").pluck().get()).toBe(READWISE_FORMAT);
    expect(queueReadwiseSweep(ctx)).toBe(0);
  });

  it("names publisher text's voices as written, and runs its unnamed text on in paragraphs that end at a sentence", () => {
    const { ctx, assetId } = recordingFixture(mp3);
    const textOf = (turns: Turn[], asr = false) => {
      const t = storeTranscript(ctx, assetId, buildTranscript(turns, asr ? {} : { relabel_speakers: false }), {});
      const words = (ctx.db.prepare("SELECT SUM(json_array_length(words)) FROM transcript_segment WHERE transcript_id = ?").pluck().get(t.id) as number) ?? 0;
      const snip = createSnip(ctx, { client_request_id: newId(), asset_id: assetId, anchor_ms: 1000, heard_from_ms: 0 }, null).snip;
      const rev = { ...(ctx.db.prepare("SELECT * FROM snip_revision WHERE id = ?").get(snip.revision!.id) as SnipRevisionRow), transcript_id: t.id, start_word: 0, end_word: words, title: "T", summary: null };
      return highlightText(readwiseSnip(ctx, snipRow(ctx, snip.id), rev)).replace(/^T\n\nTranscript:\n/, "");
    };
    const textOfAsr = (turns: Turn[]) => textOf(turns, true);
    expect(textOf([{ speaker: "Quote", text: "I'm delighted to invest." }, { text: "Anthropic needs Nvidia the least." }])).toBe("I'm delighted to invest.\n\nAnthropic needs Nvidia the least.");
    // The quoted passage's last words aligned to the prose after it: one sentence, not two paragraphs.
    expect(textOf([{ speaker: "Quote", text: "The Americans found hospitals, to send" }, { text: "missionaries abroad. I met them." }])).toBe("The Americans found hospitals, to send missionaries abroad. I met them.");
    expect(textOf([{ speaker: "Ari Emanuel", text: "We bought it." }, { speaker: "Host", text: "Why?" }])).toBe("Ari Emanuel\nWe bought it.\n\nHost\nWhy?");
    expect(textOf([{ speaker: "Host", text: "Just me today." }])).toBe("Just me today.");
    expect(textOf([{ speaker: "Horace Dediu", text: "Just me today." }])).toBe("Horace Dediu\nJust me today.");
    expect(textOfAsr([{ speaker: "S1", text: "One." }, { speaker: "S2", text: "Two." }])).toBe("Speaker 1\nOne.\n\nSpeaker 2\nTwo.");
    expect(textOfAsr([{ speaker: "S1", text: "Alone." }])).toBe("Alone.");
  });
});

async function currentStart(ctx: AppContext, snipId: string): Promise<number> {
  return ctx.db.prepare("SELECT r.start_ms FROM snip s JOIN snip_revision r ON r.id = s.current_revision_id WHERE s.id = ?").pluck().get(snipId) as number;
}

describe("ReadwiseApi", () => {
  const api = (respond: (url: string, init: RequestInit) => Response, seen: { url: string; init: RequestInit }[] = []) =>
    new ReadwiseApi({
      token: "tok",
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return respond(url, init);
      }) as unknown as typeof fetch,
    });
  const highlight: ReadwiseHighlight = {
    text: "t", title: "Episode", source_type: "snip_podcasts", category: "podcasts", location: 1, location_type: "time_offset", highlighted_at: "2026-11-11T00:00:00.000Z", highlight_url: "https://x/s/a",
  };

  it("posts the highlight with the token and reads back its id", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const rw = api(() => Response.json([{ id: 5, title: "Episode", modified_highlights: [77] }]), seen);
    expect(await rw.create(highlight)).toEqual({ highlight_id: 77 });
    expect(seen[0]!.url).toBe("https://readwise.io/api/v2/highlights/");
    expect(seen[0]!.init.method).toBe("POST");
    expect((seen[0]!.init.headers as Record<string, string>).Authorization).toBe("Token tok");
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ highlights: [highlight] });
    expect(await api(() => Response.json([{ id: 5 }])).create(highlight)).toEqual({ highlight_id: null });
  });

  it("calls a missing highlight gone, a refused token permanent, and a rate limit or outage worth a retry", async () => {
    expect(await api(() => new Response("", { status: 404 })).update(1, { text: "t", note: "", location: 1, url: "u" })).toBe("gone");
    expect(await api(() => new Response(null, { status: 204 })).remove(1)).toBe("ok");
    await expect(api(() => new Response("bad token", { status: 401 })).create(highlight)).rejects.toBeInstanceOf(NonRetryable);
    await expect(api(() => new Response("{\"text\":[\"too long\"]}", { status: 400 })).create(highlight)).rejects.toBeInstanceOf(NonRetryable);
    for (const status of [429, 503]) {
      const err = await api(() => new Response("", { status })).create(highlight).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(NonRetryable);
    }
  });
});
