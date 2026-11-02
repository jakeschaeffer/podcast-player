import { describe, expect, it } from "vitest";
import { buildTranscript, conversation, lcg } from "../../../test/helpers/transcript.js";
import { sliceWords } from "../transcript/normalize.js";
import { DEFAULT_SELECT_PREFS, selectSpan, wordRangeByMidpoint, type SpanPicker } from "./select.js";
import { sentencize } from "./sentencize.js";

const prefs = DEFAULT_SELECT_PREFS;

describe("selectSpan without a transcript", () => {
  it("returns the fixed fallback ending at the tap", async () => {
    const sel = await selectSpan({ transcript: null, anchor_ms: 500_000, heard_from_ms: 0, duration_ms: 3_600_000 });
    expect(sel).toMatchObject({ method: "fixed", start_ms: 410_000, end_ms: 500_000, start_word: null, end_word: null });
    expect(sel.window).toEqual({ lo_ms: 320_000, hi_ms: 500_000, short_exception: false, min_relaxed: false });
  });

  it("never reaches before heard_from or before zero", async () => {
    const a = await selectSpan({ transcript: null, anchor_ms: 500_000, heard_from_ms: 470_000, duration_ms: 3_600_000 });
    expect(a).toMatchObject({ start_ms: 470_000, end_ms: 500_000 });
    expect(a.window.short_exception).toBe(false);
    const b = await selectSpan({ transcript: null, anchor_ms: 20_000, heard_from_ms: 0, duration_ms: 3_600_000 });
    expect(b).toMatchObject({ start_ms: 0, end_ms: 20_000 });
    expect(b.window.short_exception).toBe(true);
  });
});

describe("selectSpan with a transcript", () => {
  // A long two-speaker conversation so a 90 second span has room on both sides.
  const t = conversation(3, 10);
  const sentences = sentencize(t);
  const duration_ms = t.segments.at(-1)!.end_ms + 5000;
  const mid = sentences[Math.floor(sentences.length / 2)]!;
  const anchor = mid.end_ms + 2000;

  it("ends at the latest complete sentence before the tap and starts at the sentence nearest 90 seconds back", async () => {
    const sel = await selectSpan({ transcript: t, anchor_ms: anchor, heard_from_ms: 0, duration_ms });
    expect(sel.method).toBe("snap");
    expect(sel.end_word).toBe(mid.end_word);
    expect(sel.end_ms).toBeLessThanOrEqual(anchor);
    const start = sel.sentences.find((s) => s.start_word === sel.start_word)!;
    const dist = Math.abs(mid.end_ms - start.start_ms - prefs.target_ms);
    for (const s of sel.sentences.filter((x) => x.eligible && x.id <= mid.id)) {
      const d = mid.end_ms - s.start_ms;
      if (d >= prefs.min_ms && d <= prefs.max_ms) expect(Math.abs(d - prefs.target_ms)).toBeGreaterThanOrEqual(dist);
    }
    expect(sel.snap).toEqual({ start_id: sel.chosen!.start_id, end_id: sel.chosen!.end_id });
  });

  it("does not include words spoken after the tap", async () => {
    const inside = mid.start_ms + 400; // tapped two words into the sentence
    const sel = await selectSpan({ transcript: t, anchor_ms: inside, heard_from_ms: 0, duration_ms });
    expect(sel.end_ms).toBeLessThanOrEqual(inside);
    expect(sel.end_word).toBe(sentences[mid.id - 1]!.end_word);
  });

  it("skips a short interjection as the end when a fuller sentence precedes it", async () => {
    const tt = buildTranscript([
      { speaker: "host", text: "Welcome back to the show. Today we are talking about pricing experiments and what people get wrong about them." },
      { speaker: "guest", text: "The first thing we tried was a flat monthly fee for everyone. It felt simple and fair. We ran it for three months and almost nobody upgraded. The problem was that the people who got the most value were paying the same as people who barely used it.", pause_ms: 600 },
      { speaker: "host", text: "Right.", pause_ms: 300 },
    ]);
    const ss = sentencize(tt);
    const right = ss.find((s) => s.text === "Right.")!;
    const sel = await selectSpan({ transcript: tt, anchor_ms: right.end_ms + 100, heard_from_ms: 0, duration_ms: 10_000_000 });
    expect(sel.eligible_end_ids).not.toContain(right.id);
    expect(sliceWords(tt, sel.start_word!, sel.end_word!).map((w) => w[2]).at(-1)).toBe("it.");
  });

  it("respects heard_from so a seek never leaks earlier audio", async () => {
    const from = sentences[mid.id - 2]!;
    const sel = await selectSpan({ transcript: t, anchor_ms: anchor, heard_from_ms: from.start_ms, duration_ms });
    expect(sel.window.short_exception).toBe(true);
    expect(sel.start_ms).toBeGreaterThanOrEqual(from.start_ms);
    expect(sel.start_word).toBeGreaterThanOrEqual(from.start_word);
  });

  it("pads into silence but never into a neighbouring word or past the tap", async () => {
    const sel = await selectSpan({ transcript: t, anchor_ms: anchor, heard_from_ms: 0, duration_ms });
    const prev = sel.start_word! > 0 ? sliceWords(t, sel.start_word! - 1, sel.start_word!)[0]! : null;
    const first = sliceWords(t, sel.start_word!, sel.start_word! + 1)[0]!;
    expect(sel.start_ms).toBeLessThanOrEqual(first[0]);
    if (prev) expect(sel.start_ms).toBeGreaterThanOrEqual(prev[1]);
    expect(sel.end_ms).toBeLessThanOrEqual(anchor);
  });

  it("offers the model a few starts around the snap and keeps the end fixed", async () => {
    let offered: number[] = [];
    let endSeen = -1;
    const good: SpanPicker = async ({ candidate_start_ids, end_id, snap_start_id }) => {
      offered = candidate_start_ids;
      endSeen = end_id;
      expect(candidate_start_ids).toContain(snap_start_id);
      return { start_id: candidate_start_ids[0]!, reason: "earliest offered" };
    };
    const picked = await selectSpan({ transcript: t, anchor_ms: anchor, heard_from_ms: 0, duration_ms, picker: good });
    expect(picked.method).toBe("model");
    expect(offered.length).toBeLessThanOrEqual(2 * prefs.model_start_radius + 1);
    expect(offered.length).toBeGreaterThan(1);
    expect(endSeen).toBe(picked.snap!.end_id);
    expect(picked.chosen!.start_id).toBe(offered[0]);
    expect(picked.end_word).toBe(mid.end_word);

    const bad: SpanPicker = async () => ({ start_id: 999, reason: "nonsense" });
    const rejected = await selectSpan({ transcript: t, anchor_ms: anchor, heard_from_ms: 0, duration_ms, picker: bad });
    expect(rejected.method).toBe("snap");
    expect(rejected.model_rejection).toMatch(/not among the offered/);
    expect(rejected.chosen!.start_id).toBe(rejected.snap!.start_id);

    const throwing: SpanPicker = async () => { throw new Error("timeout"); };
    const failed = await selectSpan({ transcript: t, anchor_ms: anchor, heard_from_ms: 0, duration_ms, picker: throwing });
    expect(failed.method).toBe("snap");
    expect(failed.model_rejection).toMatch(/timeout/);
  });

  it("scores inside the band when a band is set", async () => {
    const banded = await selectSpan({ transcript: t, anchor_ms: anchor, heard_from_ms: 0, duration_ms, prefs: { snap_band_ms: 20_000 } });
    expect(banded.method).toBe("heuristic");
    expect(banded.end_word).toBe(mid.end_word);
    const chosen = banded.candidates.find((c) => c.start_id === banded.chosen!.start_id)!;
    expect(chosen.distance_ms).toBeLessThanOrEqual(banded.candidates.reduce((m, c) => Math.min(m, c.distance_ms), Number.POSITIVE_INFINITY) + 20_000);
  });

  it("is deterministic", async () => {
    const a = await selectSpan({ transcript: t, anchor_ms: anchor, heard_from_ms: 0, duration_ms });
    const b = await selectSpan({ transcript: t, anchor_ms: anchor, heard_from_ms: 0, duration_ms });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("selectSpan invariants over random taps", () => {
  const t = conversation(7, 12);
  const duration_ms = t.segments.at(-1)!.end_ms + 2000;
  const rand = lcg(42);

  it("always stays inside the window and obeys the duration rule", async () => {
    for (let i = 0; i < 200; i++) {
      const anchor = Math.floor(rand() * duration_ms);
      const heard = rand() < 0.3 ? Math.max(0, anchor - Math.floor(rand() * 240_000)) : 0;
      const sel = await selectSpan({ transcript: t, anchor_ms: anchor, heard_from_ms: heard, duration_ms });
      const { lo_ms, hi_ms, short_exception, min_relaxed } = sel.window;
      expect(sel.start_ms).toBeGreaterThanOrEqual(lo_ms);
      expect(sel.end_ms).toBeLessThanOrEqual(hi_ms);
      expect(sel.end_ms).toBeGreaterThanOrEqual(sel.start_ms);
      if (sel.method !== "fixed") {
        const words = sliceWords(t, sel.start_word!, sel.end_word!);
        expect(words.length).toBeGreaterThan(0);
        expect(words[0]![0]).toBeGreaterThanOrEqual(sel.start_ms);
        expect(words.at(-1)![1]).toBeLessThanOrEqual(sel.end_ms);
        const dur = words.at(-1)![1] - words[0]![0];
        if (!short_exception && !min_relaxed) expect(dur).toBeGreaterThanOrEqual(prefs.min_ms);
        expect(dur).toBeLessThanOrEqual(prefs.max_ms);
        for (const c of sel.candidates) {
          expect(c.duration_ms).toBeLessThanOrEqual(prefs.max_ms);
          if (!short_exception && !min_relaxed) expect(c.duration_ms).toBeGreaterThanOrEqual(prefs.min_ms);
        }
      }
    }
  });
});

describe("wordRangeByMidpoint", () => {
  it("includes words whose midpoint falls inside the range", () => {
    const t = buildTranscript([{ text: "one two three four five" }]);
    const w = sliceWords(t, 0, 5);
    const start = (w[1]![0] + w[1]![1]) / 2 - 1;
    const end = (w[3]![0] + w[3]![1]) / 2 + 1;
    expect(wordRangeByMidpoint(t, start, end)).toEqual({ start_word: 1, end_word: 4 });
    expect(wordRangeByMidpoint(t, 0, 1)).toBeNull();
  });
});
