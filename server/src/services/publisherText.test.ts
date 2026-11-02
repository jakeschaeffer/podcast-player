import { describe, expect, it } from "vitest";
import { alignTokens } from "../core/transcript/align.js";
import { attachParagraphs } from "./publisherText.js";

describe("attachParagraphs", () => {
  const paragraphs = [
    { text: "On to the Update:", speaker: null, quote: false, section: -1 },
    { text: "Netflix reported slow growth.", speaker: null, quote: true, section: 0 },
    { text: "I’ll pick up this one.", speaker: "Greg Peters", quote: true, section: 0 },
    { text: "Here is what I think.", speaker: null, quote: false, section: 1 },
  ];
  const text = paragraphs.map((p) => p.text).join("\n\n");
  const sections = [{ title: "Netflix Earnings", first_paragraph: 1 }, { title: "Business", first_paragraph: 3 }];
  const tokens = text.split(/\s+/);
  const aligned = tokens.map((t, i) => ({ text: t, start_ms: i * 400, end_ms: i * 400 + 300, loss: 0.1 }));

  it("gives words their paragraph's speaker and quote marker and times the sections", () => {
    const { words, sections: timed } = attachParagraphs(text, { paragraphs, sections }, aligned);
    expect(words).toHaveLength(tokens.length);
    expect(words[0]!.speaker).toBeUndefined();
    expect(words[4]!.speaker).toBe("Quote");
    expect(words[8]!.speaker).toBe("Greg Peters");
    expect(words.at(-1)!.speaker).toBeUndefined();
    expect(timed).toEqual([
      { title: "Netflix Earnings", first_paragraph: 1, start_word: 4, start_ms: 1600 },
      { title: "Business", first_paragraph: 3, start_word: 13, start_ms: 5200 },
    ]);
  });

  it("copes with the aligner splitting or merging tokens", () => {
    const uneven = [...aligned.slice(0, 4), { text: "Netflix", start_ms: 1600, end_ms: 1700, loss: 0.1 }, { text: "reported", start_ms: 1700, end_ms: 1800, loss: 0.1 }, { text: "slow", start_ms: 1900, end_ms: 2000, loss: 0.1 }, { text: "growth", start_ms: 2100, end_ms: 2200, loss: 0.1 }, ...aligned.slice(8)];
    const { words } = attachParagraphs(text, { paragraphs, sections }, uneven);
    expect(words).toHaveLength(uneven.length);
    expect(words[4]!.speaker).toBe("Quote");
    expect(words.at(-1)!.speaker).toBeUndefined();
  });
});

describe("alignTokens", () => {
  it("counts substitutions, deletions, and insertions and returns matched pairs", () => {
    const ref = "the quick brown fox jumps over the lazy dog".split(" ");
    const hyp = "the quick brown fox um jumps over a lazy dog".split(" ");
    const a = alignTokens(ref, hyp);
    expect(a).toMatchObject({ sub: 1, del: 0, ins: 1 });
    expect(a.pairs).toHaveLength(8);
    expect(a.pairs[0]).toEqual([0, 0]);
    expect(a.pairs.at(-1)).toEqual([8, 9]);
  });

  it("handles long sequences inside the band", () => {
    const ref = Array.from({ length: 3000 }, (_, i) => `w${i % 97}`);
    const hyp = [...ref.slice(0, 1500), "extra", "words", ...ref.slice(1500)];
    const a = alignTokens(ref, hyp, 50);
    expect(a.ins).toBe(2);
    expect(a.sub + a.del).toBe(0);
    expect(a.pairs).toHaveLength(3000);
  });
});
