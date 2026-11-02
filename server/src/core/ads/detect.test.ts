import { describe, expect, it } from "vitest";
import { normalize } from "../transcript/normalize.js";
import type { EventTuple, NormalizedTranscript, RawWord } from "../transcript/types.js";
import { detectAds } from "./detect.js";

/** Words spoken back to back from `at`, 400 ms apart. */
function speak(text: string, at: number): RawWord[] {
  return text.split(/\s+/).filter(Boolean).map((w, i) => ({ text: w, start_ms: at + i * 400, end_ms: at + i * 400 + 300 }));
}

function transcript(words: RawWord[], events: EventTuple[] = []): NormalizedTranscript {
  const t = normalize({ provider: "test", model: "test", language: "en", words, events: [] });
  return { ...t, events };
}

/** Distinct filler words so the aligner has real text to match: "w0 w1 w2 …". */
function prose(n: number, tag: string): string {
  return Array.from({ length: n }, (_, i) => `${tag}${i}`).join(" ");
}

/** Where a block of `n` words starting at `at` ends, and where the next block starts after a pause. */
const after = (at: number, n: number, pause = 600) => at + n * 400 + pause;

describe("detectAds with publisher text", () => {
  const before = prose(200, "a");
  const ad = "This episode is brought to you by Acme. Acme makes the best widgets. " + prose(110, "ad") + " Go to acme dot com today.";
  const rest = prose(200, "b");
  const adWords = ad.split(/\s+/).length;
  const t1 = after(0, 200);
  const t2 = after(t1, adWords);
  const speech = transcript([...speak(before, 0), ...speak(ad, t1), ...speak(rest, t2)]);
  const publisher = transcript([...speak(before, 0), ...speak(rest, t2)]);

  it("finds the speech the article does not have, with exact edges", () => {
    const breaks = detectAds({ speech, publisher: { transcript: publisher, verbatim: true }, duration_ms: t2 + 200 * 400 });
    expect(breaks).toHaveLength(1);
    const [b] = breaks;
    expect(b!.start_ms).toBe(t1);
    expect(b!.end_ms).toBe(t2 - 100);
    expect(b!.confidence).toBe("high");
    expect(b!.sources).toEqual(["publisher_gap", "sponsor_phrase"]);
    expect(b!.cue).toBe("this episode is brought to you by");
  });

  it("needs a second signal in an edited interview transcript, but not in verbatim text", () => {
    const unsponsored = prose(adWords, "aside");
    const s = transcript([...speak(before, 0), ...speak(unsponsored, t1), ...speak(rest, t2)]);
    expect(detectAds({ speech: s, publisher: { transcript: publisher, verbatim: false }, duration_ms: t2 + 80_000 })).toEqual([]);
    const lone = detectAds({ speech: s, publisher: { transcript: publisher, verbatim: true }, duration_ms: t2 + 80_000 });
    expect(lone).toHaveLength(1);
    expect(lone[0]!.confidence).toBe("medium");
    expect(lone[0]!.sources).toEqual(["publisher_gap"]);
  });

  it("confirms an edited-transcript gap with an ad chapter", () => {
    const unsponsored = prose(adWords, "aside");
    const s = transcript([...speak(before, 0), ...speak(unsponsored, t1), ...speak(rest, t2)]);
    const breaks = detectAds({ speech: s, publisher: { transcript: publisher, verbatim: false }, chapters: [{ start_ms: t1 - 500, end_ms: t2, kind: "ad" }], duration_ms: t2 + 80_000 });
    expect(breaks.map((b) => b.sources)).toEqual([["publisher_gap", "ad_chapter"]]);
  });

  it("ignores a short passage such as the intro line", () => {
    const intro = "This is Ben Thompson and here is today's Update.";
    const s = transcript([...speak(intro, 0), ...speak(before, 4_000)]);
    const p = transcript(speak(before, 4_000));
    expect(detectAds({ speech: s, publisher: { transcript: p, verbatim: true }, duration_ms: 90_000 })).toEqual([]);
  });

  it("finds a sponsor read that the article prints too, where no gap can show it", () => {
    // Stratechery runs its sponsor read in the article as well as the audio.
    const read = "This update is presented by Stripe. " + prose(60, "s") + ". Back to the update.";
    const t1 = after(0, 100);
    const t2 = after(t1, read.split(/\s+/).length);
    const s = transcript([...speak(prose(100, "c"), 0), ...speak(read, t1), ...speak(prose(100, "d"), t2)]);
    const breaks = detectAds({ speech: s, publisher: { transcript: s, verbatim: true }, chapters: [{ start_ms: t1 + 1_500, end_ms: t2 + 3_000, kind: "ad" }], duration_ms: t2 + 40_000 });
    // The read opens on its cue's sentence, before the chapter (which a model cut mid-sentence), and ends on its
    // hand-back line, which beats the chapter's end.
    expect(breaks).toEqual([{ start_ms: t1, end_ms: t2 - 100, confidence: "high", sources: ["sponsor_phrase", "ad_chapter"], cue: "this update is presented by" }]);
  });
});

describe("detectAds from the speech alone", () => {
  it("bounds a sponsor read by its hand-back line", () => {
    const content = prose(100, "x") + ".";
    const read = "Today's show is brought to you by Acme. " + prose(60, "r") + ". And now back to the show.";
    const t1 = after(0, 101);
    const readWords = read.split(/\s+/).length;
    const t2 = after(t1, readWords, 400);
    const s = transcript([...speak(content, 0), ...speak(read, t1), ...speak(prose(50, "y"), t2)]);
    const breaks = detectAds({ speech: s, duration_ms: t2 + 20_000 });
    expect(breaks).toHaveLength(1);
    expect(breaks[0]!.start_ms).toBe(t1);
    expect(breaks[0]!.end_ms).toBe(t2 - 100);
    expect(breaks[0]!.sources).toEqual(["sponsor_phrase"]);
    expect(breaks[0]!.confidence).toBe("medium");
  });

  it("ends a read at a music sting", () => {
    const read = "This episode is brought to you by Acme. " + prose(60, "r") + ".";
    const end = after(0, read.split(/\s+/).length, 0);
    const s = transcript([...speak(read, 0), ...speak(prose(50, "y"), end + 5_000)], [[end, end + 4_000, "music"]]);
    const breaks = detectAds({ speech: s, duration_ms: end + 30_000 });
    expect(breaks.map((b) => [b.start_ms, b.end_ms])).toEqual([[0, end + 4_000]]);
  });

  it("leaves a read alone when it cannot find where it ends", () => {
    const s = transcript(speak("This episode is brought to you by Acme. " + prose(400, "r"), 0));
    expect(detectAds({ speech: s, duration_ms: 200_000 })).toEqual([]);
  });

  it("uses an ad chapter's edges, and agrees with a cue inside it", () => {
    const read = "Thanks to our sponsor Acme. " + prose(60, "r");
    const s = transcript([...speak(prose(50, "x"), 0), ...speak(read, 30_000), ...speak(prose(50, "y"), 60_000)]);
    const breaks = detectAds({ speech: s, chapters: [{ start_ms: 30_000, end_ms: 59_800, kind: "ad" }, { start_ms: 59_800, end_ms: 80_000, kind: "content" }], duration_ms: 80_000 });
    expect(breaks).toEqual([{ start_ms: 30_000, end_ms: 59_800, confidence: "high", sources: ["sponsor_phrase", "ad_chapter"], cue: "thanks to our sponsor" }]);
  });

  it("takes an ad chapter alone at medium confidence and drops implausible ones", () => {
    const chapters = [
      { start_ms: 0, end_ms: 5_000, kind: "ad" },
      { start_ms: 5_000, end_ms: 40_000, kind: "ad" },
      { start_ms: 40_000, end_ms: 900_000, kind: "ad" },
    ];
    expect(detectAds({ speech: null, chapters, duration_ms: 900_000 })).toEqual([{ start_ms: 5_000, end_ms: 40_000, confidence: "medium", sources: ["ad_chapter"], cue: null }]);
  });
});

describe("detectAds at the end of a recording", () => {
  it("runs a post-roll read to the end, from its cue's sentence rather than a chapter cut mid-sentence", () => {
    // The End of the Internet: "This article was presented by Stripe." and the read, then nothing.
    const read = "This article was presented by Stripe. " + prose(100, "s") + ".";
    const t1 = after(0, 200);
    const s = transcript([...speak(prose(200, "c") + ".", 0), ...speak(read, t1)]);
    const end = t1 + read.split(/\s+/).length * 400 + 20_000;
    const breaks = detectAds({ speech: s, chapters: [{ start_ms: t1 + 700, end_ms: end, kind: "ad" }], duration_ms: end });
    expect(breaks).toEqual([{ start_ms: t1, end_ms: end, confidence: "high", sources: ["sponsor_phrase", "ad_chapter"], cue: "this article was presented by" }]);
  });

  it("does not take a cue far from the end as a post-roll", () => {
    const s = transcript(speak("This episode is brought to you by Acme. " + prose(240, "r") + ".", 0)); // about 100 s
    expect(detectAds({ speech: s, duration_ms: 130_000 })).toEqual([]);
  });

  it("ends a pre-roll at 'onto the update'", () => {
    const pre = "This update is presented by Stripe. Good morning. " + prose(40, "p") + ". Onto the update.";
    const t2 = after(0, pre.split(/\s+/).length, 400);
    const s = transcript([...speak(pre, 0), ...speak(prose(300, "u"), t2)]);
    expect(detectAds({ speech: s, duration_ms: 200_000 }).map((b) => [b.start_ms, b.end_ms])).toEqual([[0, t2 - 100]]);
  });
});
