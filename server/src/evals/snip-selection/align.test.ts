import { describe, expect, it } from "vitest";
import { buildTranscript, conversation } from "../../../test/helpers/transcript.js";
import { sliceWords } from "../../core/transcript/normalize.js";
import { alignSnip, tokenize } from "./align.js";

describe("tokenize", () => {
  it("lowercases, strips punctuation, and keeps apostrophes inside words", () => {
    expect(tokenize("Don’t “quote” me, OK? 2026!")).toEqual(["don't", "quote", "me", "ok", "2026"]);
  });
});

describe("alignSnip", () => {
  const t = conversation(11, 20);
  const words = sliceWords(t, 0, t.word_count);

  it("recovers an exact span and tolerates transcription differences", () => {
    const span = words.slice(400, 700);
    const exact = alignSnip(t, span.map((w) => w[2]).join(" "), { start_offset_ms: span[0]![0] });
    expect(exact).not.toBeNull();
    expect(exact!.start_word).toBe(400);
    expect(exact!.end_word).toBe(700);
    expect(exact!.coverage).toBeGreaterThan(0.95);

    // Another transcriber: different casing, some words wrong, a word dropped, speaker label lines mixed in.
    const noisy = span.map((w, i) => (i % 23 === 0 ? "um" : i % 31 === 0 ? "" : w[2].toUpperCase())).join(" ");
    const approx = alignSnip(t, `Speaker A\n${noisy}\nSpeaker B`, { start_offset_ms: span[0]![0] + 4000 });
    expect(approx).not.toBeNull();
    expect(Math.abs(approx!.start_word - 400)).toBeLessThanOrEqual(3);
    expect(Math.abs(approx!.end_word - 700)).toBeLessThanOrEqual(3);
    expect(approx!.coverage).toBeGreaterThan(0.6);
  });

  it("searches the whole transcript when the offset is far off", () => {
    const span = words.slice(1000, 1200);
    const a = alignSnip(t, span.map((w) => w[2]).join(" "), { start_offset_ms: 5_000 });
    expect(a).not.toBeNull();
    expect(a!.start_word).toBe(1000);
    expect(a!.end_word).toBe(1200);
  });

  it("returns null for unrelated text", () => {
    const small = buildTranscript([{ text: "one two three four five six seven eight nine ten." }]);
    expect(alignSnip(small, "completely unrelated words that never appear here at all")).toBeNull();
  });
});
