import { describe, expect, it } from "vitest";
import { endsSentence, normalize, sliceWords, speakerTurns } from "./normalize.js";
import type { RawTranscript, RawWord } from "./types.js";

/** Build evenly spaced words: 300 ms long, `gap_ms` apart, optional speaker per word. */
function words(texts: string[], opts: { start_ms?: number; gap_ms?: number; speaker?: (i: number) => string | undefined } = {}): RawWord[] {
  const gap = opts.gap_ms ?? 50;
  let t = opts.start_ms ?? 0;
  return texts.map((text, i) => {
    const w: RawWord = { text, start_ms: t, end_ms: t + 300 };
    const spk = opts.speaker?.(i);
    if (spk) w.speaker = spk;
    t += 300 + gap;
    return w;
  });
}

function raw(ws: RawWord[], events: RawTranscript["events"] = []): RawTranscript {
  return { provider: "test", model: "fixture", language: "eng", words: ws, events };
}

describe("normalize", () => {
  it("assigns contiguous global word indices and preserves every word", () => {
    const t = normalize(raw(words(Array.from({ length: 150 }, (_, i) => `w${i}`))));
    expect(t.word_count).toBe(150);
    let expectedFirst = 0;
    for (const s of t.segments) {
      expect(s.first_word).toBe(expectedFirst);
      expect(s.words.length).toBeGreaterThan(0);
      expect(s.words.length).toBeLessThanOrEqual(60);
      expectedFirst += s.words.length;
    }
    expect(expectedFirst).toBe(150);
  });

  it("drops empty tokens and tokens without timings, and rounds to integer milliseconds", () => {
    const t = normalize(
      raw([
        { text: " ", start_ms: 0, end_ms: 10 },
        { text: "a", start_ms: 10.4, end_ms: 310.6 },
        { text: "b", start_ms: Number.NaN, end_ms: 500 },
        { text: "c", start_ms: 400, end_ms: 700 },
      ]),
    );
    expect(t.word_count).toBe(2);
    expect(t.segments[0]!.words).toEqual([[10, 311, "a"], [400, 700, "c"]]);
  });

  it("clamps overlapping words so timings are monotonic and non-overlapping", () => {
    const t = normalize(
      raw([
        { text: "a", start_ms: 0, end_ms: 500 },
        { text: "b", start_ms: 400, end_ms: 350 },
        { text: "c", start_ms: 450, end_ms: 900 },
      ]),
    );
    const flat = t.segments.flatMap((s) => s.words);
    expect(flat).toEqual([[0, 500, "a"], [500, 500, "b"], [500, 900, "c"]]);
    for (let i = 1; i < flat.length; i++) expect(flat[i]![0]).toBeGreaterThanOrEqual(flat[i - 1]![1]);
  });

  it("clamps to the asset duration when given", () => {
    const t = normalize(raw([{ text: "a", start_ms: 900, end_ms: 1500 }]), { duration_ms: 1000 });
    expect(t.segments[0]!.words).toEqual([[900, 1000, "a"]]);
  });

  it("relabels speakers S1, S2 by order of first appearance and splits segments on speaker change", () => {
    const ws = words(["hi", "there", "yes", "ok", "back"], { speaker: (i) => (i < 2 ? "speaker_7" : i < 4 ? "speaker_2" : "speaker_7") });
    const t = normalize(raw(ws));
    expect(t.segments.map((s) => s.speaker)).toEqual(["S1", "S2", "S1"]);
    expect(t.segments.map((s) => s.text)).toEqual(["hi there", "yes ok", "back"]);
  });

  it("has null speakers and no speaker splits when the provider gave none", () => {
    const t = normalize(raw(words(["a", "b", "c"])));
    expect(t.segments).toHaveLength(1);
    expect(t.segments[0]!.speaker).toBeNull();
  });

  it("splits on a pause of 700 ms or more but not on a shorter one", () => {
    const ws: RawWord[] = [
      { text: "a", start_ms: 0, end_ms: 300 },
      { text: "b", start_ms: 999, end_ms: 1300 }, // 699 ms gap: same segment
      { text: "c", start_ms: 2000, end_ms: 2300 }, // 700 ms gap: new segment
    ];
    const t = normalize(raw(ws));
    expect(t.segments.map((s) => s.text)).toEqual(["a b", "c"]);
    expect(t.segments[1]!.first_word).toBe(2);
  });

  it("closes a segment at the first sentence end after the soft cap and never exceeds the hard cap", () => {
    // 45 words, a period after word 42 (index 41), then more words.
    const texts = Array.from({ length: 45 }, (_, i) => (i === 41 ? "end." : `w${i}`));
    const t = normalize(raw(words(texts)));
    expect(t.segments.map((s) => s.words.length)).toEqual([42, 3]);
    expect(t.segments[0]!.words.at(-1)![2]).toBe("end.");

    const noPunct = normalize(raw(words(Array.from({ length: 130 }, (_, i) => `w${i}`))));
    expect(noPunct.segments.map((s) => s.words.length)).toEqual([60, 60, 10]);
  });

  it("builds segment text and times from its words", () => {
    const t = normalize(raw(words(["Hello,", "world."], { start_ms: 1000 })));
    const s = t.segments[0]!;
    expect(s).toMatchObject({ idx: 0, start_ms: 1000, end_ms: 1650, text: "Hello, world.", first_word: 0 });
  });

  it("sorts and rounds events", () => {
    const t = normalize(raw(words(["a"]), [
      { label: "laughter", start_ms: 5000.4, end_ms: 5600 },
      { label: " music ", start_ms: 0, end_ms: 1800 },
      { label: "", start_ms: 1, end_ms: 2 },
    ]));
    expect(t.events).toEqual([[0, 1800, "music"], [5000, 5600, "laughter"]]);
  });

  it("is deterministic", () => {
    const ws = words(Array.from({ length: 200 }, (_, i) => (i % 17 === 0 ? "stop." : `w${i}`)), { speaker: (i) => `spk_${i % 3}` });
    const a = JSON.stringify(normalize(raw(ws)));
    const b = JSON.stringify(normalize(raw(ws)));
    expect(a).toBe(b);
  });

  it("rejects nonsensical caps", () => {
    expect(() => normalize(raw([]), { soft_cap_words: 10, hard_cap_words: 5 })).toThrow();
  });
});

describe("endsSentence", () => {
  it("recognises terminal punctuation with trailing quotes", () => {
    for (const s of ["done.", "really?", "wow!", 'said."', "yes.’", "and…", "ok.)"]) expect(endsSentence(s)).toBe(true);
    for (const s of ["is,", "the", "well;", "-"]) expect(endsSentence(s)).toBe(false);
  });
});

describe("sliceWords", () => {
  const t = normalize(raw(words(Array.from({ length: 100 }, (_, i) => `w${i}`), { gap_ms: 50 })), { hard_cap_words: 30, soft_cap_words: 30 });

  it("returns words across segment boundaries by global index", () => {
    const slice = sliceWords(t, 28, 33);
    expect(slice.map((w) => w[2])).toEqual(["w28", "w29", "w30", "w31", "w32"]);
  });

  it("handles empty and full ranges and rejects out-of-range ones", () => {
    expect(sliceWords(t, 10, 10)).toEqual([]);
    expect(sliceWords(t, 0, 100)).toHaveLength(100);
    expect(() => sliceWords(t, -1, 5)).toThrow(RangeError);
    expect(() => sliceWords(t, 5, 101)).toThrow(RangeError);
    expect(() => sliceWords(t, 6, 5)).toThrow(RangeError);
  });

  it("groups a range into speaker turns, running segments by the same speaker together", () => {
    const texts = ["So", "what", "happened?", "We", "tried", "a", "flat", "fee.", "Right.", "Then", "usage."];
    const who = (i: number) => (i < 3 || i === 8 ? "speaker_0" : "speaker_1");
    const t = normalize(raw(words(texts, { speaker: who })));
    expect(speakerTurns(t, 1, 10)).toEqual([
      { speaker: "S1", text: "what happened?" },
      { speaker: "S2", text: "We tried a flat fee." },
      { speaker: "S1", text: "Right." },
      { speaker: "S2", text: "Then" },
    ]);
    expect(speakerTurns(normalize(raw(words(texts))), 0, 11)).toEqual([{ speaker: null, text: texts.join(" ") }]);
  });
});
