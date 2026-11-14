import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseAgainstSchema, type TextModel } from "../src/adapters/textModel.js";
import type { AppContext } from "../src/app/context.js";
import { PASSAGE_EPS_MS, PASSAGE_MIN_MS } from "../src/core/snip/episodeMap.js";
import type { SnipRevisionRow } from "../src/db/rows.js";
import { drain } from "../src/jobs/worker.js";
import { newId } from "../src/lib/ids.js";
import { loadEpisodeMap, queueEpisodeMap } from "../src/services/episodeMaps.js";
import { reportPlayback } from "../src/services/playback.js";
import { getPrompt } from "../src/services/prompts.js";
import { boundaryEditRates } from "../src/services/snipEdits.js";
import { createSnip } from "../src/services/snips.js";
import { summarizeSnipGaveUp } from "../src/services/snipJobs.js";
import { storeTranscript } from "../src/services/transcripts.js";
import { makeTone, PRICING, recordingFixture, transcriptAbout } from "./helpers/fixture.js";

/**
 * The map marks every third sentence as a passage start. Every summary request fails as an unreachable model would,
 * so what the snip shows meanwhile, and after, is the map's doing alone.
 */
class Mapper implements TextModel {
  readonly name = "mapper";
  maps = 0;
  async generate(req: Parameters<TextModel["generate"]>[0]) {
    const props = (req.schema as { properties?: Record<string, unknown> }).properties ?? {};
    if (!("thoughts" in props)) throw new Error("ECONNRESET");
    this.maps++;
    const ids = [...req.user.matchAll(/^\[(\d+)\] /gm)].map((m) => Number(m[1])).filter((id) => id % 3 === 0);
    const thoughts = ids.map((start_id) => ({ start_id, title: `Passage ${start_id}`, major: start_id === 0, needs_start: true }));
    return { data: parseAgainstSchema(req.schema, { thoughts }) as never, model: "mapper", elapsed_ms: 1 };
  }
}

describe("episode maps in production", () => {
  let ctx: AppContext;
  let assetId: string;
  let model: Mapper;
  const revisionOf = (snipId: string) => ctx.db.prepare("SELECT r.* FROM snip_revision r JOIN snip s ON s.current_revision_id = r.id WHERE s.id = ?").get(snipId) as SnipRevisionRow;
  const snipAt = (anchor_ms: number) => createSnip(ctx, { client_request_id: newId(), asset_id: assetId, anchor_ms, heard_from_ms: 0 }, null).snip.id;
  const deviceId = newId();

  beforeAll(async () => {
    model = new Mapper();
    ({ ctx, assetId } = recordingFixture(await makeTone(), { textModel: model }));
    ctx.config.episodeMaps = true;
    ctx.db.prepare("INSERT INTO device (id, name, platform, token_hash, created_at) VALUES (?, 'test', 'ios', ?, ?)").run(deviceId, newId(), ctx.now());
    storeTranscript(ctx, assetId, transcriptAbout(PRICING), {});
  });
  afterAll(() => ctx.db.close());

  it("asks for a map while the episode plays, once, and keeps it", async () => {
    // Stored before anyone listened: no map yet, so nothing is spent on episodes nobody plays.
    expect(ctx.db.prepare("SELECT COUNT(*) FROM job WHERE kind = 'map_episode'").pluck().get()).toBe(0);
    for (let seq = 1; seq <= 3; seq++) reportPlayback(ctx, deviceId, assetId, { position_ms: seq * 1000, speed: 1, playing: true, finished: false, seq });
    expect(ctx.db.prepare("SELECT COUNT(*) FROM job WHERE kind = 'map_episode'").pluck().get()).toBe(1);
    await drain(ctx, { kinds: ["map_episode"] });
    expect(model.maps).toBe(1);
    const transcriptId = ctx.db.prepare("SELECT transcript_id FROM audio_asset WHERE id = ?").pluck().get(assetId) as string;
    const map = loadEpisodeMap(ctx, transcriptId);
    expect(map?.prompt_version).toBe("v3");
    expect(map!.map.starts.length).toBeGreaterThan(5);
    queueEpisodeMap(ctx, transcriptId);
    await drain(ctx, { kinds: ["map_episode"] });
    expect(model.maps).toBe(1);
  });

  it("starts a snip where the passage playing before the tap began, titled by it until the summary is written", async () => {
    const anchor = 100_000;
    const id = snipAt(anchor);
    await drain(ctx, { kinds: ["select_snip"] });
    const rev = revisionOf(id);
    expect(rev.method).toBe("map");
    expect(rev.title_source).toBe("map");
    expect(rev.title).toMatch(/^Passage \d+$/);
    expect(JSON.parse(rev.selection!).map_prompt_version).toBe("v3");
    const transcriptId = rev.transcript_id!;
    const map = loadEpisodeMap(ctx, transcriptId)!.map;
    // The rule: the latest passage start at least 10 s before the tap that leaves at least 30 s.
    const expected = map.starts.filter((s) => s.ms <= anchor - PASSAGE_EPS_MS && anchor - s.ms >= PASSAGE_MIN_MS).at(-1)!;
    expect(rev.start_word).toBe(expected.word);
    expect(rev.title).toBe(expected.title);

    // The summary model is down: the passage's title stays, rather than the excerpt's first words.
    await drain(ctx, { kinds: ["render_clip", "summarize_snip"] });
    expect(revisionOf(id).title).toBe(expected.title);
    // Its retries used up, as the worker would after a model that stays down.
    summarizeSnipGaveUp(ctx, { payload: { revision_id: rev.id } } as never, "ECONNRESET");
    const settled = revisionOf(id);
    expect(settled.status).toBe("ready");
    expect([settled.title, settled.title_source]).toEqual([expected.title, "map"]);

    // The Prompts screen counts it against the map's version.
    expect(boundaryEditRates(ctx).maps.get("v3")).toEqual({ snips: 1, edited: 0 });
    expect(getPrompt(ctx, "episode-map")).toMatchObject({ in_use: true, edits_label: "spans moved" });
  });

  it("falls back to the rules when there is no map, and asks for one for the next snip", async () => {
    const other = recordingFixture(await makeTone(), { textModel: new Mapper() });
    other.ctx.config.episodeMaps = true;
    storeTranscript(other.ctx, other.assetId, transcriptAbout(PRICING), {});
    const id = createSnip(other.ctx, { client_request_id: newId(), asset_id: other.assetId, anchor_ms: 100_000, heard_from_ms: 0 }, null).snip.id;
    await drain(other.ctx, { kinds: ["select_snip"] });
    const rev = other.ctx.db.prepare("SELECT r.* FROM snip_revision r JOIN snip s ON s.current_revision_id = r.id WHERE s.id = ?").get(id) as SnipRevisionRow;
    expect(rev.method).toBe("snap");
    expect(rev.title_source).toBeNull();
    expect(other.ctx.db.prepare("SELECT COUNT(*) FROM job WHERE kind = 'map_episode'").pluck().get()).toBe(1);
    other.ctx.db.close();
  });

  it("makes no map without a text model or with EPISODE_MAPS=off", async () => {
    const plain = recordingFixture(await makeTone());
    plain.ctx.config.episodeMaps = true;
    storeTranscript(plain.ctx, plain.assetId, transcriptAbout(PRICING), {});
    const tid = plain.ctx.db.prepare("SELECT transcript_id FROM audio_asset WHERE id = ?").pluck().get(plain.assetId) as string;
    queueEpisodeMap(plain.ctx, tid);
    expect(plain.ctx.db.prepare("SELECT COUNT(*) FROM job WHERE kind = 'map_episode'").pluck().get()).toBe(0);
    plain.ctx.db.close();
    const off = recordingFixture(await makeTone(), { textModel: new Mapper() });
    storeTranscript(off.ctx, off.assetId, transcriptAbout(PRICING), {});
    const tid2 = off.ctx.db.prepare("SELECT transcript_id FROM audio_asset WHERE id = ?").pluck().get(off.assetId) as string;
    queueEpisodeMap(off.ctx, tid2);
    expect(off.ctx.db.prepare("SELECT COUNT(*) FROM job WHERE kind = 'map_episode'").pluck().get()).toBe(0);
    off.ctx.db.close();
  });
});
