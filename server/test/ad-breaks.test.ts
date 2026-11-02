import { beforeAll, describe, expect, it } from "vitest";
import { normalize } from "../src/core/transcript/normalize.js";
import type { RawWord } from "../src/core/transcript/types.js";
import { drain } from "../src/jobs/worker.js";
import { newId } from "../src/lib/ids.js";
import { getEpisode } from "../src/services/episodes.js";
import { storeTranscript } from "../src/services/transcripts.js";
import { makeTone, recordingFixture } from "./helpers/fixture.js";

/** Words 400 ms apart from `at`. */
const speak = (text: string, at: number): RawWord[] => text.split(/\s+/).map((w, i) => ({ text: w, start_ms: at + i * 400, end_ms: at + i * 400 + 300 }));
const words = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(" ");
const transcript = (ws: RawWord[]) => normalize({ provider: "test", model: "test", language: "en", words: ws, events: [] });

const BEFORE = words(80, "a");
const AD = `This episode is brought to you by Acme. ${words(54, "ad")}`;
const AFTER = words(200, "b");
const AD_AT = 80 * 400 + 600;
const BACK_AT = AD_AT + AD.split(" ").length * 400 + 600;

let mp3: string;
beforeAll(async () => {
  mp3 = await makeTone();
});

describe("ad breaks", () => {
  it("are found once the ASR and publisher transcripts are both in, and served on the episode", async () => {
    const { ctx, assetId, episodeId } = recordingFixture(mp3);
    const device = ctx.db.prepare("INSERT INTO device (id, name, platform, token_hash, created_at) VALUES (?, 'test', 'web', ?, 0) RETURNING id").pluck().get(newId(), newId()) as string;
    expect(getEpisode(ctx, episodeId, device).ad_breaks).toEqual([]);

    storeTranscript(ctx, assetId, transcript([...speak(BEFORE, 0), ...speak(AD, AD_AT), ...speak(AFTER, BACK_AT)]), {});
    await drain(ctx, { kinds: ["detect_ads"] });
    // From the speech alone the read has no end it can find (no pause, sting, or hand-back), so nothing is offered.
    expect(getEpisode(ctx, episodeId, device).ad_breaks).toEqual([]);

    const textId = newId();
    ctx.db
      .prepare("INSERT INTO episode_text (id, episode_id, source, source_ref, title, kind, text, paragraphs, sections, word_count, created_at) VALUES (?, ?, 'rss', ?, 'Pricing', 'update', '', '[]', '[]', 160, 0)")
      .run(textId, episodeId, textId);
    storeTranscript(ctx, assetId, transcript([...speak(BEFORE, 0), ...speak(AFTER, BACK_AT)]), { source: "rss", text_id: textId, make_current: false });
    await drain(ctx, { kinds: ["detect_ads"] });
    expect(getEpisode(ctx, episodeId, device).ad_breaks).toEqual([
      { start_ms: AD_AT, end_ms: BACK_AT - 100, confidence: "high", sources: ["publisher_gap", "sponsor_phrase"], cue: "this episode is brought to you by" },
    ]);
  });

  it("are detected the moment a recording transcribed before detection existed is opened", () => {
    const { ctx, assetId, episodeId } = recordingFixture(mp3);
    storeTranscript(ctx, assetId, transcript([...speak(BEFORE, 0), ...speak(AD, AD_AT), ...speak(AFTER, BACK_AT)]), {});
    const textId = newId();
    ctx.db
      .prepare("INSERT INTO episode_text (id, episode_id, source, source_ref, title, kind, text, paragraphs, sections, word_count, created_at) VALUES (?, ?, 'rss', ?, 'Pricing', 'update', '', '[]', '[]', 160, 0)")
      .run(textId, episodeId, textId);
    storeTranscript(ctx, assetId, transcript([...speak(BEFORE, 0), ...speak(AFTER, BACK_AT)]), { source: "rss", text_id: textId, make_current: false });
    ctx.db.prepare("DELETE FROM job WHERE kind = 'detect_ads'").run(); // as if both landed before detection existed
    // The client loads the episode once as playback starts, so the first answer already has the break.
    expect(getEpisode(ctx, episodeId, "none").ad_breaks.map((b) => [b.start_ms, b.end_ms])).toEqual([[AD_AT, BACK_AT - 100]]);
    expect(ctx.db.prepare("SELECT COUNT(*) FROM job WHERE kind = 'detect_ads'").pluck().get()).toBe(0);
  });
});
