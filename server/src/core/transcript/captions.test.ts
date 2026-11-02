import { describe, expect, it } from "vitest";
import { captionsToTranscript } from "./captions.js";

// The shape YouTube's automatic captions take (json3): one segment per word, offset from the line's start. Taken
// from a Dwarkesh video; lines overlap, as they do when captions roll.
const AUTO = {
  events: [
    { tStartMs: 0, dDurationMs: 480, segs: [{ utf8: "\n" }] },
    { tStartMs: 480, dDurationMs: 3680, wWinId: 1, segs: [{ utf8: "When", acAsrConf: 0 }, { utf8: " people", tOffsetMs: 239 }, { utf8: " think", tOffsetMs: 560 }, { utf8: " of", tOffsetMs: 719 }, { utf8: " AGI,", tOffsetMs: 880 }] },
    { tStartMs: 2720, dDurationMs: 3200, wWinId: 1, aAppend: 1, segs: [{ utf8: "\n" }] },
    { tStartMs: 2720, dDurationMs: 3200, wWinId: 1, segs: [{ utf8: "what" }, { utf8: " it", tOffsetMs: 159 }, { utf8: " would", tOffsetMs: 320 }] },
  ],
};

describe("captionsToTranscript", () => {
  it("gives every automatic-caption word its own time, ending where the next word starts", () => {
    const t = captionsToTranscript(AUTO, { kind: "auto", language: "en" });
    expect(t.provider).toBe("youtube");
    expect(t.model).toBe("captions-auto");
    expect(t.words.map((w) => w.text)).toEqual(["When", "people", "think", "of", "AGI,", "what", "it", "would"]);
    expect(t.words[0]).toMatchObject({ start_ms: 480, end_ms: 719, confidence: 0 });
    expect(t.words[1]).toMatchObject({ start_ms: 719, end_ms: 1040 });
    // The last word of a line ends where the next line's first word starts, not when the line disappears.
    expect(t.words[4]).toMatchObject({ start_ms: 1360, end_ms: 2720 });
    // The last word of all would end when its line does (5920), but a word is never shown more than two seconds.
    expect(t.words[7]).toMatchObject({ start_ms: 3040, end_ms: 5040 });
  });

  it("shares a creator's line among its words by length", () => {
    const t = captionsToTranscript({ events: [{ tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: "a bigger word" }] }] }, { kind: "manual", language: null });
    expect(t.model).toBe("captions");
    expect(t.words.map((w) => [w.text, w.start_ms, w.end_ms])).toEqual([
      ["a", 1000, 1182],
      ["bigger", 1182, 2273],
      ["word", 2273, 3000],
    ]);
  });

  it("never lets a word run more than two seconds past its start, or backwards", () => {
    const t = captionsToTranscript({ events: [{ tStartMs: 0, dDurationMs: 9000, segs: [{ utf8: "long" }] }, { tStartMs: 500, dDurationMs: 100, segs: [{ utf8: "early" }, { utf8: " back", tOffsetMs: -50 }] }] }, { kind: "auto", language: "en" });
    expect(t.words.map((w) => [w.text, w.start_ms, w.end_ms])).toEqual([
      ["long", 0, 500],
      ["early", 500, 501],
      ["back", 500, 600],
    ]);
  });

  it("is empty for captions with no words", () => {
    expect(captionsToTranscript({ events: [{ tStartMs: 0, dDurationMs: 100, segs: [{ utf8: "\n" }] }] }, { kind: "auto", language: "en" }).words).toEqual([]);
    expect(captionsToTranscript({}, { kind: "auto", language: "en" }).words).toEqual([]);
  });
});
