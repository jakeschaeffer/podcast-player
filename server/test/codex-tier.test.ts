import { describe, expect, it } from "vitest";
import type { TextModel } from "../src/adapters/textModel.js";
import { textModelFor } from "../src/app/context.js";
import { PRIORITY } from "../src/jobs/queue.js";
import { newId } from "../src/lib/ids.js";
import { storeTranscript } from "../src/services/transcripts.js";
import { testContext } from "./helpers/context.js";
import { buildTranscript } from "./helpers/transcript.js";

/**
 * Work the owner asked for (Process, playing, Up Next, snips) runs on the requested Codex tier, Fast in production;
 * catalog work nobody waits on (new episodes of auto_process feeds, eval runs) runs on the background tier. The tier
 * follows the job's priority, so a transcript passes its priority on to the summary and speakers it queues.
 */
describe("Codex tier by priority", () => {
  const fast = { name: "fast" } as unknown as TextModel;
  const background = { name: "background" } as unknown as TextModel;

  it("uses the requested model above catalog and the background model at catalog", () => {
    const ctx = testContext({ textModel: fast });
    ctx.backgroundTextModel = background;
    expect(textModelFor(ctx, PRIORITY.catalog)).toBe(background);
    for (const p of [PRIORITY.upNext, PRIORITY.play, PRIORITY.snip]) expect(textModelFor(ctx, p)).toBe(fast);
  });

  function setup() {
    const ctx = testContext({ textModel: fast });
    const feedId = newId();
    const episodeId = newId();
    const assetId = newId();
    ctx.db.prepare("INSERT INTO feed (id, url_enc, url_hash, title, created_at) VALUES (?, ?, ?, 'Show', 0)").run(feedId, Buffer.from("x"), feedId);
    ctx.db.prepare("INSERT INTO episode (id, feed_id, guid, title, first_seen_at, enclosure_url_enc) VALUES (?, ?, 'g1', 'Episode', 0, ?)").run(episodeId, feedId, Buffer.from("x"));
    ctx.db.prepare("INSERT INTO audio_asset (id, episode_id, sha256, bytes, duration_ms, mime, path, created_at) VALUES (?, ?, ?, 10, 60000, 'audio/mpeg', '/audio', 0)").run(assetId, episodeId, assetId);
    ctx.db.prepare("UPDATE episode SET current_asset_id = ? WHERE id = ?").run(assetId, episodeId);
    const t = buildTranscript([{ speaker: "speaker_A", text: "Hello there." }, { speaker: "speaker_B", text: "This is a test." }]);
    return { ctx, assetId, t };
  }

  it("queues an asked-for episode's summary and speakers at the priority of its transcription", () => {
    const { ctx, assetId, t } = setup();
    const row = storeTranscript(ctx, assetId, t, { priority: PRIORITY.play });
    expect(ctx.queue.byKey(`summarize_episode:${assetId}`)).toMatchObject({ priority: PRIORITY.play });
    expect(ctx.queue.byKey(`identify_speakers:${row.id}`)).toMatchObject({ priority: PRIORITY.play });
  });

  it("leaves a background episode's follow-ups at catalog", () => {
    const { ctx, assetId, t } = setup();
    const row = storeTranscript(ctx, assetId, t, {});
    expect(ctx.queue.byKey(`summarize_episode:${assetId}`)).toMatchObject({ priority: PRIORITY.catalog });
    expect(ctx.queue.byKey(`identify_speakers:${row.id}`)).toMatchObject({ priority: PRIORITY.catalog });
  });
});
