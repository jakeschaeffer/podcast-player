import { describe, expect, it } from "vitest";
import type { TextModel } from "../src/adapters/textModel.js";
import { PRIORITY } from "../src/jobs/queue.js";
import { newId } from "../src/lib/ids.js";
import { reportPlayback } from "../src/services/playback.js";
import { storeTranscript } from "../src/services/transcripts.js";
import { testContext } from "./helpers/context.js";
import { buildTranscript } from "./helpers/transcript.js";

// Never called: these tests only look at what a playback report queues.
const model = { name: "unused" } as unknown as TextModel;

/**
 * Starting playback on a transcribed episode that has no summary queues one at play priority, so a summary parked
 * while no text model was configured (or never queued) is made once the owner listens. The report itself only writes
 * a job row; a failed summary is not retried on every report.
 */
describe("playing an episode without a summary", () => {
  function setup(textModel: TextModel | null = model) {
    const ctx = testContext({ textModel });
    const feedId = newId();
    const episodeId = newId();
    const assetId = newId();
    const device = newId();
    ctx.db.prepare("INSERT INTO feed (id, url_enc, url_hash, title, created_at) VALUES (?, ?, ?, 'Show', 0)").run(feedId, Buffer.from("x"), feedId);
    ctx.db.prepare("INSERT INTO device (id, name, platform, token_hash, created_at) VALUES (?, 'phone', 'ios', ?, 0)").run(device, device);
    ctx.db.prepare("INSERT INTO episode (id, feed_id, guid, title, first_seen_at, enclosure_url_enc) VALUES (?, ?, 'g1', 'Episode', 0, ?)").run(episodeId, feedId, Buffer.from("x"));
    ctx.db.prepare("INSERT INTO audio_asset (id, episode_id, sha256, bytes, duration_ms, mime, path, created_at) VALUES (?, ?, ?, 10, 60000, 'audio/mpeg', '/audio', 0)").run(assetId, episodeId, assetId);
    ctx.db.prepare("UPDATE episode SET current_asset_id = ? WHERE id = ?").run(assetId, episodeId);
    const key = `summarize_episode:${assetId}`;
    let seq = 0;
    const play = (playing = true) => reportPlayback(ctx, device, assetId, { position_ms: 1000, speed: 1, playing, finished: false, seq: ++seq });
    const transcribe = () => storeTranscript(ctx, assetId, buildTranscript([{ speaker: "speaker_A", text: "Hello there. This is a test." }]), {});
    return { ctx, assetId, key, play, transcribe };
  }

  it("re-queues a summary parked while no text model was configured, at play priority", () => {
    const { ctx, key, play, transcribe } = setup();
    transcribe();
    const job = ctx.queue.byKey(key)!;
    ctx.queue.defer(job.id, "no text model configured (set TEXT_MODEL=codex-cli)");
    play(false);
    expect(ctx.queue.byKey(key)).toMatchObject({ status: "deferred" }); // a paused report asks for nothing
    play();
    expect(ctx.queue.byKey(key)).toMatchObject({ id: job.id, status: "queued", priority: PRIORITY.play });
  });

  it("queues a summary that was never asked for", () => {
    const { ctx, key, play, transcribe } = setup();
    transcribe();
    ctx.db.prepare("DELETE FROM job WHERE key = ?").run(key);
    play();
    expect(ctx.queue.byKey(key)).toMatchObject({ status: "queued", priority: PRIORITY.play });
  });

  it("raises a queued catalog summary to play priority", () => {
    const { ctx, key, play, transcribe } = setup();
    transcribe();
    expect(ctx.queue.byKey(key)).toMatchObject({ status: "queued", priority: PRIORITY.catalog });
    play();
    expect(ctx.queue.byKey(key)).toMatchObject({ status: "queued", priority: PRIORITY.play });
  });

  it("leaves a failed summary failed, so a rejected one is not retried on every report", () => {
    const { ctx, key, play, transcribe } = setup();
    transcribe();
    ctx.queue.fail(ctx.queue.byKey(key)!.id, "episode summary rejected", { retryable: false });
    play();
    expect(ctx.queue.byKey(key)).toMatchObject({ status: "failed" });
  });

  it("asks for nothing without a transcript, with a summary, or without a text model", () => {
    const untranscribed = setup();
    untranscribed.play();
    expect(untranscribed.ctx.queue.byKey(untranscribed.key)).toBeNull();

    const summarized = setup();
    summarized.transcribe();
    summarized.ctx.db.prepare("DELETE FROM job WHERE key = ?").run(summarized.key);
    summarized.ctx.db.pragma("foreign_keys = OFF");
    summarized.ctx.db.prepare("UPDATE audio_asset SET summary_id = 'present' WHERE id = ?").run(summarized.assetId);
    summarized.play();
    expect(summarized.ctx.queue.byKey(summarized.key)).toBeNull();

    const noModel = setup(null);
    noModel.transcribe();
    const job = noModel.ctx.queue.byKey(noModel.key)!;
    noModel.ctx.queue.defer(job.id, "no text model configured (set TEXT_MODEL=codex-cli)");
    noModel.play();
    expect(noModel.ctx.queue.byKey(noModel.key)).toMatchObject({ status: "deferred" });
  });
});
