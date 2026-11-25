/**
 * Golden cases for sentencizer_v1 (core/snip/sentencize.ts) beyond the ones select_v2.json carries: the merge rule for
 * short fragments, the options, the 120 s margin, and transcripts no provider would produce (gaps in the word
 * indices, times that run backwards, speaker labels that differ only in Unicode form). The Swift port
 * (ios/Packages/SnipCore) replays this file and the `sentencize` cases of selection/select_v2.json. Inputs are invented.
 */
import { describe, expect, it } from "vitest";
import { SENTENCIZER_VERSION, sentencize, type SentencizeOptions } from "../src/core/snip/sentencize.js";
import { toApiTranscript, type ApiTranscript, type WordTuple } from "../src/core/transcript/types.js";
import { golden } from "./helpers/golden.js";
import { buildTranscript, fromApiTranscript, type Turn } from "./helpers/transcript.js";

const twoSpeakers: Turn[] = [
  { speaker: "host", text: "So the thing is, we never tested demand. It took a year to notice." },
  { speaker: "guest", text: "Right.", pause_ms: 200 },
  { speaker: "host", text: "Why not? Because the first approach failed quietly. Yeah." },
  { speaker: "host", text: "After a long pause we tried again.", pause_ms: 3_000 },
];

/** Short fragments in every position the merge rule distinguishes. */
const fragments: Turn[] = [
  { speaker: "A", text: "Yeah.", pause_ms: 500 },
  { speaker: "A", text: "Okay. Sure. Fine then. We should start with the numbers from last quarter. Good.", pause_ms: 300 },
  { speaker: "B", text: "Mm.", pause_ms: 100 },
  // The builder leaves 360 ms after a sentence end, so this turn starts 699 ms after "Mm." and joins it.
  { speaker: "B", text: "Go on.", pause_ms: 339 },
  { speaker: "A", text: "Right. So.", pause_ms: 300 },
  { speaker: "A", text: "No.", pause_ms: 2_000 },
  { speaker: "A", text: "Not yet. Three words here. And two.", pause_ms: 339 },
  // 700 ms after "two.": a pause, so it stays alone.
  { speaker: "A", text: "Wait.", pause_ms: 340 },
  { speaker: "B", text: "One two three four five six seven eight nine ten", pause_ms: 300 },
  { speaker: "B", text: "eleven twelve", pause_ms: 800 },
];

const closers: Turn[] = [
  { text: 'He said "wait…" and left. "Really?" (Yes.) [No!] She wrote ‘fine.’ Then “done.” and more words follow here. A.B. went home at 3.5 percent. End' },
];

const beyondAscii: Turn[] = [
  { speaker: "x", text: "Café naïve résumé 🎉. 日本語 です。 ¿Qué tal? 👍🏽 👍🏽 👍🏽! été été été." },
];

/** Six and a half minutes of speech with no punctuation and no pause: only the margin can cut it. */
const runOn: Turn[] = [{ speaker: "A", text: Array.from({ length: 980 }, (_, i) => `r${i}`).join(" "), pause_ms: 0 }];

const w = (start: number, end: number, text: string): WordTuple => [start, end, text];
const segment = (spk: string | null, w0: number, words: WordTuple[]) => ({ s: words[0]![0], e: words[words.length - 1]![1], spk, w0, words });
const handBuilt = (segments: ApiTranscript["segments"]): ApiTranscript => ({ language: "eng", word_count: segments.reduce((n, s) => n + s.words.length, 0), segments, events: [] });

const transcripts: Record<string, ApiTranscript> = {
  two_speakers: toApiTranscript(buildTranscript(twoSpeakers)),
  no_speakers: toApiTranscript(buildTranscript(twoSpeakers.map(({ speaker: _, ...t }) => t))),
  fragments: toApiTranscript(buildTranscript(fragments)),
  closers: toApiTranscript(buildTranscript(closers)),
  beyond_ascii: toApiTranscript(buildTranscript(beyondAscii)),
  run_on: toApiTranscript(buildTranscript(runOn)),
  empty: handBuilt([]),
  one_word: handBuilt([segment(null, 0, [w(5_000, 5_400, "Hello")])]),
  // Segment indices that skip: words 3..9 are missing, so a sentence cannot run across.
  index_gap: handBuilt([
    segment("S1", 0, [w(0, 300, "one"), w(350, 650, "two"), w(700, 1_000, "three")]),
    segment("S1", 10, [w(1_050, 1_350, "eleven"), w(1_400, 1_700, "twelve")]),
    segment("S1", 12, [w(1_750, 2_050, "thirteen"), w(2_100, 2_400, "fourteen."), w(2_450, 2_750, "Fifteen")]),
  ]),
  // Times that run backwards: from 200 s the margin starts at 80 s, which the second word ends before and its
  // neighbours do not, so the words read are not consecutive.
  backwards_times: handBuilt([
    segment("S1", 0, [w(79_000, 201_000, "kept"), w(79_500, 79_900, "dropped"), w(200_500, 201_500, "after"), w(201_550, 201_900, "it"), w(201_950, 202_300, "all."), w(202_000, 202_100, "early"), w(210_000, 210_400, "late"), w(209_000, 209_500, "earlier")]),
  ]),
  // The same name composed and decomposed: two speakers to the reference, which compares code units.
  unicode_speakers: handBuilt([
    segment("José", 0, [w(0, 300, "Hi"), w(350, 650, "there")]),
    segment("José", 2, [w(700, 1_000, "Hello")]),
    segment("José", 3, [w(1_050, 1_350, "Shall"), w(1_400, 1_700, "we")]),
    segment("José", 5, [w(1_750, 2_050, "start?")]),
  ]),
  zero_length: handBuilt([
    segment(null, 0, [w(1_000, 1_000, "a"), w(1_000, 1_000, "b."), w(1_000, 1_000, "c"), w(1_700, 1_700, "d"), w(1_700, 1_700, "e")]),
    segment(null, 5, [w(1_700, 1_700, "f"), w(2_399, 2_399, "g"), w(3_099, 3_099, "h")]),
  ]),
  // A speaker label on some segments only.
  mixed_speakers: handBuilt([
    segment(null, 0, [w(0, 300, "No"), w(350, 650, "label")]),
    segment("S1", 2, [w(700, 1_000, "Labelled"), w(1_050, 1_350, "now.")]),
    segment("", 4, [w(1_400, 1_700, "Empty"), w(1_750, 2_050, "label")]),
    segment(null, 6, [w(2_100, 2_400, "again")]),
  ]),
};

const first = (name: string) => transcripts[name]!.segments[0]!.s;
const last = (name: string) => transcripts[name]!.segments.at(-1)!.e;

const options: Record<string, SentencizeOptions[]> = {
  two_speakers: [
    {},
    { from_ms: 0 },
    { to_ms: 5_000 },
    { from_ms: 5_000 },
    { from_ms: 7_300, to_ms: 7_301 },
    { from_ms: 8_000.5, to_ms: 12_000.25 },
    // "Why not?" runs from 8700 to 9440: a range edge half a millisecond inside it still overlaps.
    { from_ms: 9_439.5 },
    { from_ms: 9_439.6, to_ms: 9_439.9 },
    { from_ms: 9_440 },
    { to_ms: 8_700.4 },
    { to_ms: 8_700 },
    { from_ms: 12_000, to_ms: 8_000 },
    { from_ms: -50_000, to_ms: -1 },
    { from_ms: last("two_speakers"), to_ms: last("two_speakers") + 10_000 },
    { from_ms: last("two_speakers") - 1 },
    { to_ms: first("two_speakers") },
    { to_ms: first("two_speakers") + 1 },
    { from_ms: 1_000_000 },
    { pause_split_ms: 200 },
    { pause_split_ms: 5_000 },
    { pause_split_ms: 0 },
    { min_words: 1 },
    { min_words: 0 },
    { min_words: 5 },
    { min_words: 100 },
    { min_words: 2, pause_split_ms: 360 },
  ],
  no_speakers: [{}, { min_words: 1 }, { from_ms: 9_000, to_ms: 12_000 }],
  fragments: [{}, { min_words: 1 }, { min_words: 2 }, { min_words: 4 }, { pause_split_ms: 699 }, { pause_split_ms: 701 }, { pause_split_ms: 2_500 }, { min_words: 4, pause_split_ms: 300 }, { from_ms: 14_000, to_ms: 16_000 }],
  closers: [{}, { min_words: 1 }],
  beyond_ascii: [{}, { min_words: 1 }],
  run_on: [{}, { from_ms: 190_000, to_ms: 200_000 }, { from_ms: 120_000 }, { to_ms: 120_000 }, { from_ms: 200_000.5, to_ms: 200_000.5 }, { from_ms: 0, to_ms: 1 }, { from_ms: last("run_on") - 1 }],
  empty: [{}, { from_ms: 0, to_ms: 1_000 }],
  one_word: [{}, { from_ms: 5_400 }, { from_ms: 5_399 }, { to_ms: 5_000 }, { to_ms: 5_001 }, { min_words: 5 }],
  index_gap: [{}, { min_words: 1 }, { min_words: 10 }],
  backwards_times: [{}, { from_ms: 200_000 }, { from_ms: 199_900 }, { from_ms: 199_899 }, { from_ms: 201_000 }, { to_ms: 79_600 }, { from_ms: 202_050, to_ms: 202_060 }],
  unicode_speakers: [{}, { min_words: 1 }],
  zero_length: [{}, { min_words: 1 }, { from_ms: 1_000, to_ms: 1_700 }, { from_ms: 999, to_ms: 1_001 }, { pause_split_ms: 699 }],
  mixed_speakers: [{}, { min_words: 1 }],
};

function buildCases() {
  return Object.entries(options).flatMap(([name, list]) => {
    const t = fromApiTranscript(transcripts[name]!);
    return list.map((o) => ({ transcript: name, options: o, expect: sentencize(t, o) }));
  });
}

describe("sentencizer_v1 golden cases", () => {
  const cases = buildCases();
  const texts = (name: string, o: SentencizeOptions = {}) => cases.find((c) => c.transcript === name && JSON.stringify(c.options) === JSON.stringify(o))!.expect.map((s) => s.text);

  it("behave as intended", () => {
    expect(texts("two_speakers")).toEqual(["So the thing is, we never tested demand.", "It took a year to notice.", "Right.", "Why not?", "Because the first approach failed quietly. Yeah.", "After a long pause we tried again."]);
    expect(texts("two_speakers", { from_ms: 7_300, to_ms: 7_301 })).toEqual(["Right."]);
    expect(texts("two_speakers", { from_ms: 12_000, to_ms: 8_000 })).toEqual([]);
    expect(texts("two_speakers", { from_ms: 9_439.5 })[0]).toBe("Why not?");
    expect(texts("two_speakers", { from_ms: 9_439.6, to_ms: 9_439.9 })).toEqual(["Why not?"]);
    expect(texts("two_speakers", { from_ms: 9_440 })[0]).not.toBe("Why not?");
    expect(texts("two_speakers", { to_ms: 8_700.4 }).at(-1)).toBe("Why not?");
    expect(texts("two_speakers", { to_ms: 8_700 }).at(-1)).toBe("Right.");
    expect(texts("two_speakers", { min_words: 1 })).toContain("Yeah.");
    // A short fragment joins the sentence before it only when the same speaker said both with no long pause between.
    expect(texts("fragments")).toEqual(["Yeah. Okay. Sure. Fine then.", "We should start with the numbers from last quarter. Good.", "Mm. Go on.", "Right. So.", "No. Not yet.", "Three words here. And two.", "Wait.", "One two three four five six seven eight nine ten", "eleven twelve"]);
    expect(texts("fragments", { pause_split_ms: 699 })).toContain("Mm.");
    // A closing quote or bracket after the full stop still ends the sentence; the curly double quote is not one of them.
    expect(texts("closers", { min_words: 1 })).toEqual(['He said "wait…"', "and left.", '"Really?"', "(Yes.)", "[No!]", "She wrote ‘fine.’", "Then “done.” and more words follow here.", "A.B.", "went home at 3.5 percent.", "End"]);
    // The margin cuts a run-on 120 s before and after the range.
    const cut = cases.find((c) => c.transcript === "run_on" && c.options.from_ms === 190_000)!.expect;
    expect(cut).toHaveLength(1);
    expect(cut[0]!.start_ms).toBeGreaterThan(190_000 - 120_000 - 400);
    expect(cut[0]!.end_ms).toBeLessThan(200_000 + 120_000 + 400);
    expect(cut[0]!.start_word).toBeGreaterThan(0);
    expect(texts("index_gap")).toEqual(["one two three", "eleven twelve thirteen fourteen. Fifteen"]);
    expect(texts("backwards_times", { from_ms: 200_000 })).toEqual(["kept", "after it all. early", "late earlier"]);
    // One millisecond earlier the dropped word is read too, and the sentence then ends where it does: before the range.
    expect(texts("backwards_times", { from_ms: 199_899 })).toEqual(["after it all. early", "late earlier"]);
    expect(texts("unicode_speakers")).toEqual(["Hi there", "Hello", "Shall we start?"]);
    expect(cases.some((c) => c.expect.length === 0)).toBe(true);
    for (const c of cases) c.expect.forEach((s, i) => expect(s.id).toBe(i));
  });

  it("match the committed file", () => {
    const file = {
      family: "sentences",
      version: SENTENCIZER_VERSION,
      reference: ["server/src/core/snip/sentencize.ts"],
      transcripts,
      sentencize: cases,
    };
    expect(golden(`selection/${SENTENCIZER_VERSION}.json`, file)).toEqual(JSON.parse(JSON.stringify(file)));
  });
});
