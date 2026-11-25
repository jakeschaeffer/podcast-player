/**
 * Golden cases for normalize_v1 (core/transcript/normalize.ts): raw provider words in, the stored transcript out,
 * plus `endsSentence`, `sliceWords` and `speakerTurns`. The phone transcribes audio itself on the build with no server
 * (docs/store-app-plan.md) and must store the same segments the server would; the Swift port (ios/Packages/SnipCore)
 * replays this file. Inputs are invented.
 *
 * JSON has no NaN or Infinity, so a non-finite time in a raw word or event is written as the string "NaN",
 * "Infinity" or "-Infinity" (contracts/golden/README.md).
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_NORMALIZE_OPTIONS, NORMALIZER_VERSION, endsSentence, normalize, sliceWords, speakerTurns, type NormalizeOptions, type SpeakerTurn } from "../src/core/transcript/normalize.js";
import type { NormalizedTranscript, RawEvent, RawTranscript, RawWord, WordTuple } from "../src/core/transcript/types.js";
import { golden } from "./helpers/golden.js";

/** Evenly spaced words: 300 ms long, `gap_ms` apart, optional speaker per word. */
function words(texts: string[], opts: { start_ms?: number; gap_ms?: number; speaker?: (i: number) => string | undefined } = {}): RawWord[] {
  const gap = opts.gap_ms ?? 50;
  let t = opts.start_ms ?? 0;
  return texts.map((text, i) => {
    const w: RawWord = { text, start_ms: t, end_ms: t + 300 };
    const spk = opts.speaker?.(i);
    if (spk !== undefined) w.speaker = spk;
    t += 300 + gap;
    return w;
  });
}

const numbered = (n: number, tag = "w") => Array.from({ length: n }, (_, i) => `${tag}${i}`);
const at = (text: string, start_ms: number, end_ms: number, speaker?: string): RawWord => (speaker === undefined ? { text, start_ms, end_ms } : { text, start_ms, end_ms, speaker });

function raw(ws: RawWord[], events: RawEvent[] = [], extra: Partial<RawTranscript> = {}): RawTranscript {
  return { provider: "test", model: "fixture", language: "eng", words: ws, events, ...extra };
}

// "José" composed (one code point for é) and decomposed (e + combining acute): equal to a reader, different strings.
const JOSE_NFC = "José";
const JOSE_NFD = "José";

type Input = { name: string; raw: RawTranscript; options?: Partial<NormalizeOptions> };

const inputs: Input[] = [
  { name: "empty", raw: raw([]) },
  { name: "one word", raw: raw([at("Hello.", 1_000, 1_400)]) },
  { name: "one word with a speaker", raw: raw([at("Hello.", 1_000, 1_400, "speaker_0")]) },
  { name: "150 words fill segments to the hard cap", raw: raw(words(numbered(150))) },
  { name: "130 unpunctuated words", raw: raw(words(numbered(130))) },
  { name: "segment text and times come from its words", raw: raw(words(["Hello,", "world."], { start_ms: 1_000 })) },
  {
    name: "empty and untimed tokens are dropped",
    raw: raw([
      at(" ", 0, 10),
      at("", 10, 20),
      at("a", 10.4, 310.6),
      at("b", Number.NaN, 500),
      at("c", 400, Number.NaN),
      at("d", 400, Number.POSITIVE_INFINITY),
      at("e", Number.NEGATIVE_INFINITY, 450),
      at("f", 400, 700),
      at("\t\n\r", 700, 800),
      at(" ", 700, 800), // no-break space
      at("﻿", 700, 800), // byte order mark: JavaScript trims it
      at("　", 700, 800), // ideographic space
      at(" ", 700, 800), // line separator
      at("  ", 700, 800), // em space, thin space
    ]),
  },
  {
    name: "characters that look blank but are kept",
    raw: raw([
      at("​", 0, 100), // zero width space: not whitespace to JavaScript
      at("\u0085", 100, 200), // next line: not whitespace to JavaScript
      at("᠎", 200, 300), // Mongolian vowel separator
      at("⁠", 300, 400), // word joiner
      at("­", 400, 500), // soft hyphen
    ]),
  },
  {
    name: "text is trimmed at both ends only",
    raw: raw([
      at("  hello  ", 0, 100),
      at(" world﻿", 100, 200),
      at("two words", 200, 300),
      at("\n\tline.\r\n", 300, 400),
      at("​zero", 400, 500),
      at("x\u0085", 500, 600),
      at(" sep ", 600, 700),
      at(" 　wide　 ", 700, 800),
    ]),
  },
  {
    name: "times round half up, like Math.round",
    raw: raw(
      [
        at("a", 0.49999999999999994, 0.5),
        at("b", 1.5, 2.5),
        at("c", 3.4999, 4.5001),
        at("d", 10.4, 310.6),
        at("e", 1_000.5, 1_001.5),
        at("f", 4_503_599_627_370_495.5, 4_503_599_627_370_497),
      ],
      [
        { label: "neg half", start_ms: -0.5, end_ms: -0.5 },
        { label: "neg one and a half", start_ms: -1.5, end_ms: -1.5 },
        { label: "neg two and a half", start_ms: -2.5, end_ms: -2.5 },
        { label: "neg past half", start_ms: -2.51, end_ms: -2.49 },
        { label: "half", start_ms: 0.5, end_ms: 1.5 },
        { label: "just under half", start_ms: 0.49999999999999994, end_ms: 2.5 },
      ],
    ),
  },
  { name: "overlapping words are clamped", raw: raw([at("a", 0, 500), at("b", 400, 350), at("c", 450, 900)]) },
  { name: "a word that ends before it starts", raw: raw([at("a", 500, 200), at("b", 600, 100), at("c", 650, 651)]) },
  { name: "words given out of order", raw: raw([at("third", 2_000, 2_300), at("first", 0, 300), at("fourth", 2_400, 2_700), at("second", 400, 700)]) },
  {
    name: "equal start times keep the provider's order",
    raw: raw([at("b1", 500, 600), at("a1", 0, 100), at("b2", 500, 700), at("b3", 500, 550), at("a2", 0, 50), at("r1", 10.4, 20), at("r2", 9.6, 30), at("r3", 10.2, 40)]),
  },
  { name: "times before zero", raw: raw([at("a", -500, -200), at("b", -100, 300), at("c", 250, 600)]) },
  { name: "zero-length words at one instant", raw: raw([at("a", 1_000, 1_000), at("b", 1_000, 1_000), at("c", 1_000, 1_000), at("d", 1_699, 1_699), at("e", 2_399, 2_399)]) },
  { name: "the asset's duration caps a word's end", raw: raw([at("a", 900, 1_500)]), options: { duration_ms: 1_000 } },
  {
    name: "words past the duration collapse onto it",
    raw: raw([at("a", 0, 400), at("b", 900, 1_500), at("c", 1_200, 1_500), at("d", 5_000, 5_400), at("e", 9_000, 9_100)]),
    options: { duration_ms: 1_000 },
  },
  { name: "a duration of zero", raw: raw([at("a", 0, 400), at("b", 900, 1_500)]), options: { duration_ms: 0 } },
  { name: "rounding happens before the duration cap", raw: raw([at("a", 0, 999.6), at("b", 999.5, 999.9)]), options: { duration_ms: 999 } },
  {
    name: "speakers are relabelled in order of first appearance",
    raw: raw(words(["hi", "there", "yes", "ok", "back"], { speaker: (i) => (i < 2 ? "speaker_7" : i < 4 ? "speaker_2" : "speaker_7") })),
  },
  { name: "no speakers", raw: raw(words(["a", "b", "c"])) },
  {
    name: "words with and without a speaker",
    raw: raw(words(["a", "b", "c", "d", "e", "f", "g"], { speaker: (i) => (i === 0 || i === 6 ? undefined : i < 3 ? "x" : i === 3 ? "" : "y") })),
  },
  { name: "provider labels that look like ours", raw: raw(words(["a", "b", "c", "d"], { speaker: (i) => (i < 2 ? "S2" : "S1") })) },
  { name: "twelve speakers", raw: raw(words(numbered(24), { speaker: (i) => `spk_${11 - (i % 12)}` })) },
  { name: "labels differ by a space or by case", raw: raw(words(["a", "b", "c", "d"], { speaker: (i) => ["speaker_0", " speaker_0", "Speaker_0", "speaker_0"][i] })) },
  { name: "labels that differ only in Unicode form are different speakers", raw: raw(words(["a", "b", "c", "d"], { speaker: (i) => (i % 2 === 0 ? JOSE_NFC : JOSE_NFD) })) },
  {
    name: "labels are kept when relabelling is off",
    raw: raw(words(["Why", "now?", "Because", "it", "works.", "He", "said", "so.", "Fine."], { speaker: (i) => (i < 2 ? "Host" : i < 5 ? "Mara Quill" : i < 8 ? "" : "Host") })),
    options: { relabel_speakers: false },
  },
  {
    name: "kept labels that differ only in Unicode form",
    raw: raw(words(["a", "b", "c", "d", "e"], { speaker: (i) => (i < 2 ? JOSE_NFC : i < 4 ? JOSE_NFD : JOSE_NFC) })),
    options: { relabel_speakers: false },
  },
  { name: "kept labels, none given", raw: raw(words(["a", "b"])), options: { relabel_speakers: false } },
  { name: "relabelling asked for by name", raw: raw(words(["a", "b"], { speaker: () => "narrator" })), options: { relabel_speakers: true } },
  { name: "a pause of 699 ms joins and 700 ms splits", raw: raw([at("a", 0, 300), at("b", 999, 1_300), at("c", 2_000, 2_300)]) },
  { name: "a shorter pause setting", raw: raw([at("a", 0, 300), at("b", 499, 800), at("c", 1_000, 1_300), at("d", 1_300, 1_600)]), options: { pause_split_ms: 200 } },
  { name: "a pause setting of zero splits every word", raw: raw(words(["a", "b", "c"], { gap_ms: 0 })), options: { pause_split_ms: 0 } },
  { name: "a long pause setting", raw: raw([at("a", 0, 300), at("b", 5_000, 5_300), at("c", 65_300, 65_600)]), options: { pause_split_ms: 60_000 } },
  { name: "the pause is measured after clamping", raw: raw([at("a", 0, 2_000), at("b", 1_000, 1_100), at("c", 2_650, 2_900), at("d", 3_600, 3_700)]) },
  { name: "a segment closes at the first sentence end after the soft cap", raw: raw(words(Array.from({ length: 45 }, (_, i) => (i === 41 ? "end." : `w${i}`)))) },
  {
    name: "sentence ends before the soft cap do not close a segment",
    raw: raw(words(Array.from({ length: 70 }, (_, i) => (i === 9 || i === 38 ? "stop." : `w${i}`)))),
  },
  { name: "a sentence end on the fortieth word closes it", raw: raw(words(Array.from({ length: 50 }, (_, i) => (i === 39 ? "stop." : `w${i}`)))) },
  { name: "the hard cap wins when no sentence ends", raw: raw(words(Array.from({ length: 125 }, (_, i) => (i === 100 ? "late." : `w${i}`)))) },
  { name: "caps of one", raw: raw(words(["a", "b.", "c"])), options: { soft_cap_words: 1, hard_cap_words: 1 } },
  { name: "equal caps of thirty", raw: raw(words(numbered(100))), options: { soft_cap_words: 30, hard_cap_words: 30 } },
  {
    name: "which endings close a sentence",
    raw: raw(
      words(["so", "done.", "so", "really?", "so", "wow!", "so", 'said."', "so", "yes.’", "so", "and…", "so", "ok.)", "so", "end.]", "so", "is,", "so", "well;", "so", "end.”", "so", "U.S.", "so", "a.b", "so", "(why?)", "so", "end。", "so", "3.5", "so", "é.", "so", "🎉.", "so", ".🎉", "so", "last"]),
    ),
    options: { soft_cap_words: 2, hard_cap_words: 4 },
  },
  {
    name: "speaker change, pause and caps together",
    raw: raw(words(Array.from({ length: 200 }, (_, i) => (i % 17 === 0 ? "stop." : `w${i}`)), { speaker: (i) => `spk_${Math.floor(i / 45) % 3}`, gap_ms: 50 }).map((w, i) => (i >= 120 ? { ...w, start_ms: w.start_ms + 900, end_ms: w.end_ms + 900 } : w))),
  },
  { name: "a speaker change on every word", raw: raw(words(numbered(9), { speaker: (i) => `spk_${i % 3}` })) },
  {
    name: "events are filtered, rounded, trimmed and sorted",
    raw: raw(words(["a"]), [
      { label: "laughter", start_ms: 5_000.4, end_ms: 5_600 },
      { label: " music ", start_ms: 0, end_ms: 1_800 },
      { label: "", start_ms: 1, end_ms: 2 },
      { label: " \t ", start_ms: 1, end_ms: 2 },
      { label: "untimed", start_ms: Number.NaN, end_ms: 9 },
      { label: "endless", start_ms: 3, end_ms: Number.POSITIVE_INFINITY },
      { label: "backwards", start_ms: 7_000, end_ms: 6_000 },
      { label: "same start, later end", start_ms: 5_000, end_ms: 5_900 },
      { label: "same start, earlier end", start_ms: 5_000, end_ms: 5_100 },
      { label: "tie, given first", start_ms: 8_000, end_ms: 8_500 },
      { label: "tie, given second", start_ms: 8_000, end_ms: 8_500 },
      { label: "before zero", start_ms: -400, end_ms: -100 },
      { label: "past the duration", start_ms: 99_000, end_ms: 99_500 },
      { label: "🎵 Music 🎵", start_ms: 2_000, end_ms: 2_100 },
    ]),
    options: { duration_ms: 10_000 },
  },
  { name: "events without words", raw: raw([], [{ label: "music", start_ms: 0, end_ms: 4_000 }]) },
  {
    name: "text beyond ASCII is kept as given",
    raw: raw([
      at("naïve", 0, 300),
      at("日本語。", 350, 650),
      at("🎉", 700, 1_000), // one emoji, two UTF-16 units
      at("👨‍👩‍👧", 1_050, 1_350), // a family joined with zero width joiners
      at("🇫🇷", 1_400, 1_700), // a flag: two regional indicators
      at("été", 1_750, 2_050), // decomposed then composed
      at("مرحبا", 2_100, 2_400),
      at("¿Qué?", 2_450, 2_750),
      at("“quoted.”", 2_800, 3_100),
      at("—", 3_150, 3_450),
      at("...", 3_500, 3_800),
      at("1,000.50", 3_850, 4_150),
      at("$5", 4_200, 4_500),
    ]),
  },
  { name: "provider, model and language pass through", raw: { provider: "apple", model: "speech-transcriber", language: null, words: [at("Hi.", 0, 200)], events: [], duration_ms: 61_250, cost_cents: 0.4, provider_request_id: "req_1" } },
  { name: "confidence is read and not stored", raw: raw([{ text: "sure", start_ms: 0, end_ms: 300, confidence: 0.92 }, { text: "maybe", start_ms: 350, end_ms: 650, speaker: "a", confidence: 0 }]) },
  { name: "hours into a recording", raw: raw(words(["late", "words."], { start_ms: 7 * 3_600_000 + 123 })) },
];

const invalid: { name: string; options: Partial<NormalizeOptions> }[] = [
  { name: "hard cap below soft cap", options: { soft_cap_words: 10, hard_cap_words: 5 } },
  { name: "soft cap of zero", options: { soft_cap_words: 0 } },
  { name: "negative soft cap", options: { soft_cap_words: -1, hard_cap_words: 5 } },
  { name: "hard cap below the default soft cap", options: { hard_cap_words: 39 } },
  { name: "soft cap above the default hard cap", options: { soft_cap_words: 61 } },
];

const sentenceEnds = [
  "done.", "really?", "wow!", 'said."', "yes.’", "and…", "ok.)", "end.]", "is,", "the", "well;", "-", "", ".", "...", "…", "?!", "!?", "?)", ")", "'", '"',
  "a.b", "U.S.", "3.5", ".5", "5.", "end.'", "end.''", 'end.")]\'’', "‘end.’", "end.’‘", "end.”", "end.»", "end。", "end？", "end！", "end．",
  "end.\n", "end. ", "end. ", " end.", "end. ", "é.", ".́", "end.́", "🎉.", "end.🎉", "end‥", "end․", "end‼", "end؟", "end.x", ".'x", "end:)", "end;)", "(end.)", "[end!]", "wait…’", "wait…”",
];

/** `{ range, words }` for a slice, or `{ range, throws: true }` where the reference raises RangeError. */
function slices(t: NormalizedTranscript, ranges: [number, number][]) {
  return ranges.map(([start_word, end_word]) => {
    let out: WordTuple[];
    try {
      out = sliceWords(t, start_word, end_word);
    } catch (e) {
      expect(e).toBeInstanceOf(RangeError);
      return { start_word, end_word, throws: true as const };
    }
    return { start_word, end_word, expect: out };
  });
}

function turns(t: NormalizedTranscript, ranges: [number, number][]): { start_word: number; end_word: number; expect: SpeakerTurn[] }[] {
  return ranges.map(([start_word, end_word]) => ({ start_word, end_word, expect: speakerTurns(t, start_word, end_word) }));
}

const NON_FINITE = new Map<string, number>([["NaN", Number.NaN], ["Infinity", Number.POSITIVE_INFINITY], ["-Infinity", Number.NEGATIVE_INFINITY]]);
const writeNumber = (n: number): number | string => (Number.isFinite(n) ? n : String(n));
const readNumber = (n: number | string): number => (typeof n === "number" ? n : NON_FINITE.get(n)!);

type StoredRaw = Omit<RawTranscript, "words" | "events"> & {
  words: (Omit<RawWord, "start_ms" | "end_ms"> & { start_ms: number | string; end_ms: number | string })[];
  events: { label: string; start_ms: number | string; end_ms: number | string }[];
};

/** The raw transcript as the file holds it, with non-finite times as strings. */
function store(r: RawTranscript): StoredRaw {
  return { ...r, words: r.words.map((w) => ({ ...w, start_ms: writeNumber(w.start_ms), end_ms: writeNumber(w.end_ms) })), events: r.events.map((e) => ({ ...e, start_ms: writeNumber(e.start_ms), end_ms: writeNumber(e.end_ms) })) };
}

/** What a port does on reading the file. */
function load(r: StoredRaw): RawTranscript {
  return { ...r, words: r.words.map((w) => ({ ...w, start_ms: readNumber(w.start_ms), end_ms: readNumber(w.end_ms) })), events: r.events.map((e) => ({ ...e, start_ms: readNumber(e.start_ms), end_ms: readNumber(e.end_ms) })) };
}

/** Every code point JavaScript's `trim` removes, so a port's own list can be checked whole. */
function trimmedCodePoints(): number[] {
  const out: number[] = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    if (String.fromCodePoint(cp).trim() === "") out.push(cp);
  }
  return out;
}

function buildCases() {
  const normalizeCases = inputs.map(({ name, raw: r, options }) => {
    const stored = store(r);
    // The answer is computed from what a port will read, not from the object the file was written from.
    return { name, raw: stored, options: options ?? {}, expect: normalize(load(JSON.parse(JSON.stringify(stored)) as StoredRaw), options ?? {}) };
  });
  const by = new Map(normalizeCases.map((c) => [c.name, c.expect]));
  const of = (name: string) => by.get(name)!;

  const sliceCases = [
    { transcript: "equal caps of thirty", ranges: [[28, 33], [10, 10], [0, 100], [0, 0], [100, 100], [30, 60], [29, 31], [59, 61], [99, 100], [0, 1], [-1, 5], [5, 101], [6, 5], [-3, -3], [101, 101], [100, 99]] },
    { transcript: "empty", ranges: [[0, 0], [0, 1], [1, 1], [-1, 0]] },
    { transcript: "one word", ranges: [[0, 1], [0, 0], [1, 1], [1, 2]] },
    { transcript: "speaker change, pause and caps together", ranges: [[40, 50], [118, 123], [0, 200], [199, 200]] },
    { transcript: "text beyond ASCII is kept as given", ranges: [[2, 6], [0, 13]] },
  ] as { transcript: string; ranges: [number, number][] }[];

  const conversation = normalize(raw(words(["So", "what", "happened?", "We", "tried", "a", "flat", "fee.", "Right.", "Then", "usage."], { speaker: (i) => (i < 3 || i === 8 ? "speaker_0" : "speaker_1") })));
  const turnTranscripts: Record<string, NormalizedTranscript> = {
    "a conversation": conversation,
    "the same words without speakers": normalize(raw(words(["So", "what", "happened?", "We", "tried", "a", "flat", "fee.", "Right.", "Then", "usage."]))),
    "one speaker across a pause and a cap": normalize(raw([...words(numbered(5, "a"), { speaker: () => "x" }), ...words(numbered(70, "b"), { start_ms: 10_000, speaker: () => "x" }), ...words(numbered(3, "c"), { start_ms: 60_000, speaker: () => "y" })])),
    "kept labels that differ only in Unicode form": of("kept labels that differ only in Unicode form"),
    "labels are kept when relabelling is off": of("labels are kept when relabelling is off"),
    "words with and without a speaker": of("words with and without a speaker"),
    empty: of("empty"),
  };
  const turnRanges: Record<string, [number, number][]> = {
    "a conversation": [[1, 10], [0, 11], [0, 3], [2, 4], [8, 9], [3, 3], [6, 5], [9, 2], [-5, 1_000], [11, 20], [-4, 0], [10, 11]],
    "the same words without speakers": [[0, 11], [4, 6], [6, 4]],
    "one speaker across a pause and a cap": [[0, 78], [3, 70], [64, 66], [74, 78]],
    "kept labels that differ only in Unicode form": [[0, 5], [1, 3]],
    "labels are kept when relabelling is off": [[0, 9], [4, 9]],
    "words with and without a speaker": [[0, 7]],
    empty: [[0, 0], [0, 5]],
  };

  return {
    normalize: normalizeCases,
    normalize_invalid: invalid,
    ends_sentence: sentenceEnds.map((text) => ({ text, expect: endsSentence(text) })),
    slice_words: sliceCases.map((c) => ({ transcript: c.transcript, cases: slices(of(c.transcript), c.ranges) })),
    speaker_turns: Object.entries(turnTranscripts).map(([name, t]) => ({ name, transcript: t, cases: turns(t, turnRanges[name]!) })),
    trimmed_code_points: trimmedCodePoints(),
  };
}

describe("normalize_v1 golden cases", () => {
  const cases = buildCases();
  const by = Object.fromEntries(cases.normalize.map((c) => [c.name, c.expect]));
  const flat = (name: string) => by[name]!.segments.flatMap((s) => s.words);
  const sizes = (name: string) => by[name]!.segments.map((s) => s.words.length);

  it("behave as intended", () => {
    expect(by.empty).toEqual({ provider: "test", model: "fixture", language: "eng", word_count: 0, segments: [], events: [] });
    expect(sizes("150 words fill segments to the hard cap")).toEqual([60, 60, 30]);
    expect(flat("empty and untimed tokens are dropped")).toEqual([[10, 311, "a"], [400, 700, "f"]]);
    expect(flat("characters that look blank but are kept")).toHaveLength(5);
    expect(flat("text is trimmed at both ends only").map((w) => w[2])).toEqual(["hello", "world", "two words", "line.", "​zero", "x\u0085", "sep", "wide"]);
    expect(flat("times round half up, like Math.round").map((w) => [w[0], w[1]])).toEqual([[0, 1], [2, 3], [3, 5], [10, 311], [1_001, 1_002], [4_503_599_627_370_496, 4_503_599_627_370_497]]);
    // Math.round(-0.5) is -0, which JSON writes as 0.
    expect(by["times round half up, like Math.round"]!.events.map((e) => e[0] + 0)).toEqual([-3, -2, -1, 0, 0, 1]);
    expect(flat("overlapping words are clamped")).toEqual([[0, 500, "a"], [500, 500, "b"], [500, 900, "c"]]);
    expect(flat("equal start times keep the provider's order").map((w) => w[2])).toEqual(["a1", "a2", "r1", "r2", "r3", "b1", "b2", "b3"]);
    expect(flat("times before zero")).toEqual([[0, 0, "a"], [0, 300, "b"], [300, 600, "c"]]);
    expect(flat("words past the duration collapse onto it").map((w) => [w[0], w[1]])).toEqual([[0, 400], [900, 1_000], [1_000, 1_000], [1_000, 1_000], [1_000, 1_000]]);
    expect(by["speakers are relabelled in order of first appearance"]!.segments.map((s) => s.speaker)).toEqual(["S1", "S2", "S1"]);
    expect(by["words with and without a speaker"]!.segments.map((s) => s.speaker)).toEqual([null, "S1", null, "S2", null]);
    expect(by["provider labels that look like ours"]!.segments.map((s) => s.speaker)).toEqual(["S1", "S2"]);
    expect(by["twelve speakers"]!.segments.map((s) => s.speaker).slice(9, 12)).toEqual(["S10", "S11", "S12"]);
    expect(by["labels that differ only in Unicode form are different speakers"]!.segments.map((s) => s.speaker)).toEqual(["S1", "S2", "S1", "S2"]);
    expect(by["kept labels that differ only in Unicode form"]!.segments.map((s) => s.speaker)).toEqual([JOSE_NFC, JOSE_NFD, JOSE_NFC]);
    expect(by["labels are kept when relabelling is off"]!.segments.map((s) => s.speaker)).toEqual(["Host", "Mara Quill", null, "Host"]);
    expect(by["a pause of 699 ms joins and 700 ms splits"]!.segments.map((s) => s.text)).toEqual(["a b", "c"]);
    expect(sizes("a pause setting of zero splits every word")).toEqual([1, 1, 1]);
    expect(sizes("a segment closes at the first sentence end after the soft cap")).toEqual([42, 3]);
    expect(sizes("sentence ends before the soft cap do not close a segment")).toEqual([60, 10]);
    expect(sizes("a sentence end on the fortieth word closes it")).toEqual([40, 10]);
    expect(sizes("130 unpunctuated words")).toEqual([60, 60, 10]);
    expect(by["events are filtered, rounded, trimmed and sorted"]!.events.map((e) => e[2])).toEqual(["before zero", "music", "🎵 Music 🎵", "same start, earlier end", "laughter", "same start, later end", "backwards", "tie, given first", "tie, given second", "past the duration"]);
    for (const c of cases.normalize) {
      let first = 0;
      c.expect.segments.forEach((s, i) => {
        expect(s.idx).toBe(i);
        expect(s.first_word).toBe(first);
        first += s.words.length;
      });
      expect(first).toBe(c.expect.word_count);
    }
    for (const c of cases.normalize_invalid) expect(() => normalize(raw([]), c.options)).toThrow();
    expect(cases.ends_sentence.filter((c) => c.expect).length).toBeGreaterThan(15);
    expect(cases.ends_sentence.filter((c) => !c.expect).length).toBeGreaterThan(15);
    expect(cases.slice_words.flatMap((c) => c.cases).filter((c) => "throws" in c).length).toBeGreaterThan(5);
    // Space, tab, the line ends, no-break space, the Unicode spaces and the byte order mark; nothing else.
    expect(cases.trimmed_code_points).toHaveLength(25);
  });

  it("match the committed file", () => {
    const file = {
      family: "transcript",
      version: NORMALIZER_VERSION,
      reference: ["server/src/core/transcript/types.ts", "server/src/core/transcript/normalize.ts"],
      default_options: DEFAULT_NORMALIZE_OPTIONS,
      ...cases,
    };
    expect(golden(`transcript/${NORMALIZER_VERSION}.json`, file)).toEqual(JSON.parse(JSON.stringify(file)));
  });
});
