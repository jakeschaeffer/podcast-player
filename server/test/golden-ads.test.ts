/**
 * Golden cases for ad detection, ads_v3 (core/ads/detect.ts): the three signals (speech the publisher's text lacks,
 * sponsor phrases, ad chapters), how overlapping signals merge, every phrase the detector knows, and its options.
 * The phone finds ad breaks itself on the build with no server (docs/store-app-plan.md); the Swift port
 * (ios/Packages/SnipCore) replays this file. Sponsors, shows and speech are invented.
 */
import { describe, expect, it } from "vitest";
import { AD_DETECTOR_VERSION, DEFAULT_AD_OPTIONS, detectAds, type AdBreak, type AdOptions } from "../src/core/ads/detect.js";
import { normalize } from "../src/core/transcript/normalize.js";
import { toApiTranscript, type ApiTranscript, type EventTuple, type RawWord } from "../src/core/transcript/types.js";
import { golden } from "./helpers/golden.js";
import { fromApiTranscript } from "./helpers/transcript.js";

/** Words spoken back to back from `at`: one every 400 ms, each 300 ms long. */
function speak(text: string, at: number): RawWord[] {
  return text.split(/\s+/).filter(Boolean).map((w, i) => ({ text: w, start_ms: at + i * 400, end_ms: at + i * 400 + 300 }));
}

/** Distinct filler words so the aligner has real text to match: "a0 a1 a2 …". */
const prose = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(" ");
const count = (text: string) => text.split(/\s+/).filter(Boolean).length;
/** Where a block of `n` words starting at `at` ends, and so where the next block starts after a pause. */
const after = (at: number, n: number, pause = 600) => at + n * 400 + pause;

/**
 * Several blocks of speech. Words in a block are 100 ms apart; a block starts `silence` ms after the last word of the
 * one before (700 unless given as `[text, silence]`). `starts` is where each block starts, `end` where the last word ends.
 */
function blocks(...parts: (string | [string, number])[]): { words: RawWord[]; starts: number[]; end: number } {
  const words: RawWord[] = [];
  const starts: number[] = [];
  let end = 0;
  parts.forEach((part, i) => {
    const [text, silence] = typeof part === "string" ? [part, 700] : part;
    const start = i === 0 ? 0 : end + silence;
    starts.push(start);
    words.push(...speak(text, start));
    end = start + (count(text) - 1) * 400 + 300;
  });
  return { words, starts, end };
}

const transcripts: Record<string, ApiTranscript> = {};

/** Store a transcript under `name`, in the API shape, and return the name. */
function T(name: string, words: RawWord[], events: EventTuple[] = []): string {
  if (transcripts[name]) throw new Error(`duplicate transcript ${name}`);
  const t = normalize({ provider: "test", model: "test", language: "en", words, events: [] });
  transcripts[name] = toApiTranscript({ ...t, events });
  return name;
}

type Chapter = { start_ms: number; end_ms: number; kind: string };
type Input = { speech: string | null; publisher?: { transcript: string; verbatim: boolean } | null; chapters?: Chapter[] | null; duration_ms: number };
type Case = { name: string; input: Input; options?: Partial<AdOptions> };
const cases: Case[] = [];
const add = (name: string, input: Input, options?: Partial<AdOptions>) => cases.push(options ? { name, input, options } : { name, input });
const ad = (start_ms: number, end_ms: number): Chapter => ({ start_ms, end_ms, kind: "ad" });

// ---- Speech the publisher's text does not have -------------------------------------------------------------------

const BEFORE = prose(80, "a");
const REST = prose(80, "b");
const AD = `This episode is brought to you by Zorblat. Zorblat makes the best widgets. ${prose(110, "ad")} Go to zorblat dot com today.`;
const ASIDE = prose(count(AD), "aside");
const T1 = after(0, 80);
const T2 = after(T1, count(AD));
const GAP_MS = T2 - 100 - T1;
/** From the passage's first word to the end of its last: what the gap minimum is compared with. */
const RUN_MS = (count(AD) - 1) * 400 + 300;

const article = T("article", [...speak(BEFORE, 0), ...speak(REST, T2)]);
const withAd = T("speech with an ad the article lacks", [...speak(BEFORE, 0), ...speak(AD, T1), ...speak(REST, T2)]);
const withAside = T("speech with an unsponsored passage the article lacks", [...speak(BEFORE, 0), ...speak(ASIDE, T1), ...speak(REST, T2)]);
const DURATION = T2 + 80 * 400 + 5_000;

add("publisher gap with a sponsor phrase, verbatim text", { speech: withAd, publisher: { transcript: article, verbatim: true }, duration_ms: DURATION });
add("publisher gap with a sponsor phrase, edited text", { speech: withAd, publisher: { transcript: article, verbatim: false }, duration_ms: DURATION });
add("publisher gap alone, edited text", { speech: withAside, publisher: { transcript: article, verbatim: false }, duration_ms: DURATION });
add("publisher gap alone, verbatim text", { speech: withAside, publisher: { transcript: article, verbatim: true }, duration_ms: DURATION });
add("publisher gap alone, edited text, confirmed by an ad chapter", { speech: withAside, publisher: { transcript: article, verbatim: false }, chapters: [ad(T1 - 500, T2)], duration_ms: DURATION });
add("publisher gap beside a chapter that is not an ad", { speech: withAside, publisher: { transcript: article, verbatim: false }, chapters: [{ start_ms: T1, end_ms: T2, kind: "content" }], duration_ms: DURATION });
add("a lone gap exactly as long as the lone-gap minimum", { speech: withAside, publisher: { transcript: article, verbatim: true }, duration_ms: DURATION }, { lone_gap_min_ms: GAP_MS });
add("a lone gap one millisecond short of the lone-gap minimum", { speech: withAside, publisher: { transcript: article, verbatim: true }, duration_ms: DURATION }, { lone_gap_min_ms: GAP_MS + 1 });
add("a run of unmatched speech exactly as long as the gap minimum", { speech: withAside, publisher: { transcript: article, verbatim: true }, duration_ms: DURATION }, { min_gap_ms: RUN_MS });
add("a run of unmatched speech one millisecond short of the gap minimum", { speech: withAside, publisher: { transcript: article, verbatim: true }, duration_ms: DURATION }, { min_gap_ms: RUN_MS + 1 });
add("a gap shorter than a raised gap minimum", { speech: withAd, publisher: { transcript: article, verbatim: true }, duration_ms: DURATION }, { min_gap_ms: 60_000 });
add("a gap longer than a lowered longest break", { speech: withAside, publisher: { transcript: article, verbatim: true }, duration_ms: DURATION }, { max_break_ms: 40_000 });
add("no publisher text", { speech: withAd, publisher: null, duration_ms: DURATION });
add("no speech, only publisher text", { speech: null, publisher: { transcript: article, verbatim: true }, duration_ms: DURATION });
add("the article is the speech: no gap", { speech: article, publisher: { transcript: article, verbatim: true }, duration_ms: DURATION });

{
  const intro = "This is Mara Quill and here is today's bulletin.";
  const speech = T("a short intro the article lacks", [...speak(intro, 0), ...speak(BEFORE, 4_000)]);
  const text = T("article after a short intro", speak(BEFORE, 4_000));
  add("a short passage such as the intro line is no gap", { speech, publisher: { transcript: text, verbatim: true }, duration_ms: 90_000 });
  add("a short passage counts once the minimums are lowered", { speech, publisher: { transcript: text, verbatim: true }, duration_ms: 90_000 }, { min_gap_ms: 3_000, lone_gap_min_ms: 3_000, min_break_ms: 3_000 });
}

{
  // Two unmatched runs with two matched words between them.
  const b = blocks(prose(40, "a"), `${prose(60, "p")} isl0 isl1 ${prose(60, "q")}`, prose(40, "b"));
  const speech = T("speech with an island of matched words inside a gap", b.words);
  const text = T("article with the island's words", [...speak(prose(40, "a"), 0), ...speak("isl0 isl1", b.starts[1]! + 60 * 400), ...speak(prose(40, "b"), b.starts[2]!)]);
  const input: Input = { speech, publisher: { transcript: text, verbatim: true }, duration_ms: b.end + 5_000 };
  add("an island of matched words joins two runs into one gap", input);
  add("no islands allowed: two short gaps, neither counts alone", input, { max_island_words: 1 });
  add("no islands allowed, lower lone-gap minimum: the gaps merge and keep the first one's end", input, { max_island_words: 1, lone_gap_min_ms: 20_000 });
  add("an island exactly as long as allowed", input, { max_island_words: 2 });
}

{
  // Four unmatched words then three matched, twenty times: one run by the island rule, but too much of it matched.
  const mixed = Array.from({ length: 20 }, (_, k) => `${prose(4, `u${k}x`)} ${prose(3, `m${k}x`)}`).join(" ");
  const matched = Array.from({ length: 20 }, (_, k) => prose(3, `m${k}x`)).join(" ");
  const b = blocks(prose(40, "a"), mixed, prose(40, "b"));
  const speech = T("speech with matched and unmatched words interleaved", b.words);
  const text = T("article with every matched word", [...speak(prose(40, "a"), 0), ...speak(matched, b.starts[1]!), ...speak(prose(40, "b"), b.starts[2]!)]);
  const input: Input = { speech, publisher: { transcript: text, verbatim: true }, duration_ms: b.end + 5_000 };
  add("a run with too small a share unmatched is no gap", input);
  add("the same run with a lower share required", input, { min_unmatched_share: 0.5 });
  add("the same run with the share it has exactly", input, { min_unmatched_share: 80 / 137 });
}

{
  const b = blocks(prose(60, "a"), prose(120, "aside"));
  const speech = T("speech ending in a passage the article lacks", b.words);
  const text = T("article that ends earlier", speak(prose(60, "a"), 0));
  add("a gap at the very end runs to the recording's end", { speech, publisher: { transcript: text, verbatim: true }, duration_ms: b.end + 100 });
  add("a gap at the very end, with a long tail of silence", { speech, publisher: { transcript: text, verbatim: true }, duration_ms: b.end + 60_000 });
}

{
  const b = blocks(prose(120, "aside"), prose(60, "b"));
  const speech = T("speech opening with a passage the article lacks", b.words);
  const text = T("article that starts later", speak(prose(60, "b"), b.starts[1]!));
  add("a gap at the very start", { speech, publisher: { transcript: text, verbatim: true }, duration_ms: b.end + 5_000 });
}

{
  const b = blocks(prose(60, "a"), prose(120, "aside"), [prose(60, "b"), 5_000]);
  const speech = T("speech with silence after the passage the article lacks", b.words);
  const text = T("article around the silence", [...speak(prose(60, "a"), 0), ...speak(prose(60, "b"), b.starts[2]!)]);
  add("a gap followed by a long silence ends just after its last word", { speech, publisher: { transcript: text, verbatim: true }, duration_ms: b.end + 5_000 });
}

{
  const pitch = `${prose(30, "x")} just use code zorb for a free trial ${prose(30, "z")}`;
  const b = blocks(prose(60, "a"), pitch, prose(60, "b"));
  const speech = T("speech with a passage holding only weak phrases", b.words);
  const text = T("article without the weak-phrase passage", [...speak(prose(60, "a"), 0), ...speak(prose(60, "b"), b.starts[2]!)]);
  add("a weak phrase confirms a gap in edited text", { speech, publisher: { transcript: text, verbatim: false }, duration_ms: b.end + 5_000 });
}

{
  const read = `This episode is brought to you by Zorblat. ${prose(110, "ad")}. And now back to the show.`;
  const b = blocks(prose(60, "a"), read, prose(60, "b"));
  const speech = T("speech with a read the article lacks, ending on a hand-back", b.words);
  const text = T("article without the read", [...speak(prose(60, "a"), 0), ...speak(prose(60, "b"), b.starts[2]!)]);
  add("gap, sponsor read and ad chapter agree: the gap gives both edges", { speech, publisher: { transcript: text, verbatim: false }, chapters: [ad(b.starts[1]! + 3_000, b.starts[2]! + 4_000)], duration_ms: b.end + 5_000 });
  add("gap and sponsor read agree", { speech, publisher: { transcript: text, verbatim: false }, duration_ms: b.end + 5_000 });
}

{
  // The article prints the sponsor read too, so no gap can show it.
  const read = `This update is presented by Quillfeather. ${prose(60, "s")}. Back to the update.`;
  const b = blocks(prose(60, "c"), read, prose(60, "d"));
  const speech = T("speech whose sponsor read the article prints too", b.words);
  add("a sponsor read the article prints too, with a chapter cut mid-sentence", { speech, publisher: { transcript: speech, verbatim: true }, chapters: [ad(b.starts[1]! + 1_500, b.starts[2]! + 3_000)], duration_ms: b.end + 5_000 });
}

{
  const b = blocks(prose(40, "a"), `🎵 ${AD.split(" ").map((w, i) => (i % 9 === 8 ? `${w} — 🎉` : w)).join(" ")}`, prose(40, "b"));
  const speech = T("speech with an ad full of words that are no token", b.words);
  const text = T("article around the ad full of non-tokens", [...speak(prose(40, "a"), 0), ...speak(prose(40, "b"), b.starts[2]!)]);
  const emoji = T("article of emoji only", speak("🎵 🎉 — … 👍", 0));
  add("words that are no token are skipped by the aligner, not by the clock", { speech, publisher: { transcript: text, verbatim: true }, duration_ms: b.end + 5_000 });
  add("publisher text with no usable words", { speech, publisher: { transcript: emoji, verbatim: true }, duration_ms: b.end + 5_000 });
  add("speech with no usable words", { speech: emoji, publisher: { transcript: text, verbatim: true }, chapters: [ad(0, 12_000)], duration_ms: 20_000 });
}

// ---- Sponsor reads found in the speech alone ---------------------------------------------------------------------

{
  const read = `Today's show is brought to you by Zorblat. ${prose(60, "r")}. And now back to the show.`;
  const b = blocks(`${prose(100, "x")}.`, read, [prose(50, "y"), 500]);
  const speech = T("a read bounded by its hand-back line", b.words);
  add("a sponsor read ends on its hand-back line", { speech, duration_ms: b.end + 20_000 });
  add("a read with no end within a short longest read", { speech, duration_ms: b.end + 20_000 }, { max_read_ms: 20_000 });
  add("a read longer than a lowered longest break", { speech, duration_ms: b.end + 20_000 }, { max_break_ms: 20_000 });
  add("a read shorter than a raised shortest break", { speech, duration_ms: b.end + 20_000 }, { min_break_ms: 30_000 });
  add("a recording cut off inside the read", { speech, duration_ms: b.starts[1]! + 12_000 });
  add("a recording cut off just after the read starts", { speech, duration_ms: b.starts[1]! + 9_999 });
}

/** A read from 0 whose last word ends exactly `length` ms after it starts, then nothing. */
function readToTheEnd(length: number): RawWord[] {
  const n = Math.floor((length - 300) / 400);
  const words = speak(`This article was presented by Quillfeather. ${prose(n - 6, "s")}`, 0);
  words.push({ text: "end.", start_ms: length - 300, end_ms: length });
  return words;
}

/** A 38-word read from 0, silence from 15.1 s, and the show again at 20.2 s. */
const STING_READ = `This episode is brought to you by Zorblat. ${prose(30, "r")}.`;
const stingWords = [...speak(STING_READ, 0), ...speak(prose(20, "y"), 20_200)];
const stings: [string, EventTuple[]][] = [
  ["a music sting", [[15_200, 19_200, "music"]]],
  ["a sting labelled Music", [[15_200, 19_200, "Music"]]],
  ["a sting labelled JINGLE", [[15_200, 19_200, "JINGLE"]]],
  ["a sting inside a longer label", [[15_200, 19_200, "a short Sting plays"]]],
  ["a label that only contains the letters: testing", [[15_200, 19_200, "testing"]]],
  ["a label that only contains the letters: interesting noise", [[15_200, 19_200, "interesting noise"]]],
  ["a label that is not a sting: applause", [[15_200, 19_200, "applause"]]],
  ["a label that is not a sting: laughter and musing", [[15_200, 19_200, "laughter and musing"]]],
  ["a label with a long s is not music", [[15_200, 19_200, "muſic"]]],
  ["a label with a dotted capital I is not music", [[15_200, 19_200, "MUSİC"]]],
  ["a label with a long s is not a sting", [[15_200, 19_200, "ſting"]]],
  ["an empty label", [[15_200, 19_200, ""]]],
  ["a sting that starts the moment the last word ends", [[15_100, 16_000, "music"]]],
  ["a sting that starts one millisecond before the last word ends", [[15_099, 19_200, "music"]]],
  ["a sting that starts during the next word", [[20_300, 21_000, "music"]]],
  ["a sting that starts the moment the next word does", [[20_200, 21_000, "music"]]],
  ["a sting one millisecond before the next word", [[20_199, 21_000, "music"]]],
  ["a sting too early in the read", [[5_500, 5_590, "music"]]],
  ["a sting 10.3 seconds in", [[10_300, 10_390, "music"]]],
  ["a sting just under ten seconds in", [[9_900, 9_990, "music"]]],
  ["two stings: the first one after the word ends the read", [[5_500, 5_590, "music"], [12_300, 12_390, "jingle"], [15_200, 19_200, "music"]]],
  ["a sting whose end is before its start", [[15_200, 15_000, "music"]]],
  ["music and other events together", [[100, 900, "laughter"], [15_200, 19_200, "applause"], [15_300, 18_000, "music"], [19_000, 19_500, "sting"]]],
];
for (const [name, events] of stings) add(name, { speech: T(name, stingWords, events), duration_ms: 40_000 });
add("an early sting counts once the shortest break is lowered", { speech: "a sting too early in the read", duration_ms: 40_000 }, { min_break_ms: 2_000 });
add("a sting exactly the shortest break into the read", { speech: "a sting 10.3 seconds in", duration_ms: 40_000 }, { min_break_ms: 10_300 });
add("a sting one millisecond short of the shortest break into the read", { speech: "a sting 10.3 seconds in", duration_ms: 40_000 }, { min_break_ms: 10_301 });
add("no events at all: the read ends on the pause", { speech: T("a read then a pause", stingWords), duration_ms: 40_000 });
add("a sting long after the last word", { speech: T("a read then a sting and nothing more", speak(STING_READ, 0), [[60_000, 64_000, "music"]]), duration_ms: 70_000 });
add("a sting past the longest read", { speech: T("a read then a very late sting", speak(STING_READ, 0), [[120_001, 124_000, "music"]]), duration_ms: 130_000 });
add("a sting at the longest read exactly", { speech: T("a read then a sting at the limit", speak(STING_READ, 0), [[120_000, 124_000, "music"]]), duration_ms: 130_000 });

{
  const speech = T("a read with no end to find", speak(`This episode is brought to you by Zorblat. ${prose(330, "r")}`, 0));
  add("a read with no end is left alone", { speech, duration_ms: 200_000 });
  add("a longer longest read alone does not make it a post-roll", { speech, duration_ms: 200_000 }, { max_read_ms: 200_000 });
  add("a longer longest read and post-roll take it to the end", { speech, duration_ms: 200_000 }, { max_read_ms: 200_000, max_postroll_ms: 200_000 });
}

{
  const read = `This episode is brought to you by Zorblat. ${prose(37, "r")}`;
  const near = blocks(read, [prose(20, "y"), 2_000]);
  const far = blocks(read, [prose(20, "y"), 5_000]);
  const exact = blocks(read, [prose(20, "y"), 1_500]);
  // 200 more words: the recording ends too long after the cue for the read to count as a post-roll.
  const under = blocks(read, [prose(200, "y"), 1_499]);
  add("a read that ends on a pause resumes just before the next word", { speech: T("a read then a two second pause", near.words), duration_ms: near.end + 5_000 });
  add("a read that ends on a long pause resumes just after its last word", { speech: T("a read then a five second pause", far.words), duration_ms: far.end + 5_000 });
  add("a pause of exactly the read-end pause", { speech: T("a read then a pause of 1500 ms", exact.words), duration_ms: exact.end + 5_000 });
  add("a pause one millisecond short of the read-end pause", { speech: T("a read then a pause of 1499 ms", under.words), duration_ms: under.end + 5_000 });
  add("a shorter read-end pause", { speech: "a read then a pause of 1499 ms", duration_ms: under.end + 5_000 }, { read_end_pause_ms: 1_499 });
  add("a longer read-end pause than the pause", { speech: "a read then a two second pause", duration_ms: near.end + 5_000 }, { read_end_pause_ms: 2_001 });
  add("a pause-ended read with an ad chapter: the chapter's end wins", { speech: "a read then a two second pause", chapters: [ad(1_000, 30_000)], duration_ms: near.end + 5_000 });
  add("a pause-ended read with an ad chapter that starts first", { speech: "a read then a five second pause", chapters: [ad(-2_000, 16_000)], duration_ms: far.end + 5_000 });
}

{
  // A read whose last word ends exactly 15 s (the minimum read) after it starts, then a pause, then a long show.
  const exact = [...readToTheEnd(15_000), ...speak(prose(200, "y"), 17_000)];
  const short = [...readToTheEnd(14_999), ...speak(prose(200, "y"), 16_999)];
  add("a pause after a read of exactly the minimum length ends it", { speech: T("a 15000 ms read then a pause", exact), duration_ms: 120_000 });
  add("a pause after a read one millisecond short of the minimum does not", { speech: T("a 14999 ms read then a pause", short), duration_ms: 120_000 });
}

{
  // A hand-back whose first word starts exactly 120 s (the longest read) after the read does, and one a millisecond later.
  const read = `This episode is brought to you by Zorblat. ${prose(292, "r")}`;
  const atLimit = [...speak(read, 0), ...speak(`Back to the show. ${prose(8, "y")}`, 120_000)];
  const pastLimit = [...speak(read, 0), ...speak(`Back to the show. ${prose(8, "y")}`, 120_001)];
  add("a hand-back that starts at the longest read exactly", { speech: T("a hand-back 120000 ms into the read", atLimit), duration_ms: 200_000 });
  add("a hand-back that starts one millisecond past the longest read", { speech: T("a hand-back 120001 ms into the read", pastLimit), duration_ms: 200_000 });
}

{
  // A read that ends on a pause, then at once a second read that ends on a hand-back: one break, and the second's end.
  const b = blocks(`This episode is brought to you by Zorblat. ${prose(37, "r")}`, [`Thanks to our sponsor Quillfeather too. ${prose(20, "s")}. Back to the show.`, 2_000], prose(40, "y"));
  add("a pause-ended read followed by a hand-back read: the hand-back read gives the end and the cue", { speech: T("a pause-ended read then a hand-back read", b.words), duration_ms: b.end + 5_000 });
}

{
  // A pause eight seconds in, before the read has run its minimum, then a second pause.
  const b = blocks(`This episode is brought to you by Zorblat. ${prose(12, "r")}`, [prose(30, "s"), 2_000], [prose(30, "y"), 2_000]);
  const speech = T("a read with an early pause", b.words);
  add("a pause before the minimum read length does not end it", { speech, duration_ms: b.end + 5_000 });
  add("a lower minimum read length ends it there, too short to be a break", { speech, duration_ms: b.end + 5_000 }, { min_read_ms: 5_000 });
  add("a lower minimum read length and shortest break", { speech, duration_ms: b.end + 5_000 }, { min_read_ms: 5_000, min_break_ms: 5_000 });
}

{
  const read = `This article was presented by Quillfeather. ${prose(100, "s")}.`;
  const b = blocks(`${prose(100, "c")}.`, read);
  const speech = T("a post-roll read", b.words);
  add("a post-roll read runs to the end, from its cue's sentence", { speech, chapters: [ad(b.starts[1]! + 700, b.end + 20_000)], duration_ms: b.end + 20_000 });
  add("a post-roll read alone", { speech, duration_ms: b.end + 20_000 });
  add("a post-roll read longer than a lowered longest post-roll", { speech, duration_ms: b.end + 20_000 }, { max_postroll_ms: 30_000 });
  add("a cue far from the end is not a post-roll", { speech: T("a long read to the end", speak(`This episode is brought to you by Zorblat. ${prose(240, "r")}.`, 0)), duration_ms: 130_000 });
  for (const length of [14_999, 15_000, 90_000, 90_001]) {
    add(`a read to the end, ${length} ms long`, { speech: T(`a read to the end, ${length} ms`, readToTheEnd(length)), duration_ms: length + 1_000 });
  }
}

{
  const pre = `This update is presented by Quillfeather. Good morning. ${prose(40, "p")}. Onto the update.`;
  const b = blocks(pre, [prose(120, "u"), 500]);
  const speech = T("a pre-roll read", b.words);
  add("a pre-roll ends at 'onto the update'", { speech, duration_ms: 200_000 });
}

// Where a read starts: back to the start of the sentence its cue is in.
const READ_TAIL = `${prose(24, "r")}. Back to the show. ${prose(8, "y")}`;
const sentenceStarts: [string, (string | [string, number])[]][] = [
  ["a cue in the middle of a sentence", [`${prose(6, "x")}. And as always the show is brought to you by Zorblat. ${READ_TAIL}`]],
  ["a cue at the first word of the recording", [`Brought to you by Zorblat. ${READ_TAIL}`]],
  ["a cue sentence that runs back to the first word", [`so here we are and the show is brought to you by Zorblat. ${READ_TAIL}`]],
  ["a cue after a sentence that ends in a quote", [`${prose(6, "x")} she said "done." And the show is brought to you by Zorblat. ${READ_TAIL}`]],
  ["a cue after a sentence that ends in a bracket", [`${prose(6, "x")} (as promised.) And the show is brought to you by Zorblat. ${READ_TAIL}`]],
  ["a cue after a sentence that ends in an ellipsis", [`${prose(6, "x")} well… And the show is brought to you by Zorblat. ${READ_TAIL}`]],
  // The detector's own sentence rule has no curly quote among the closers, unlike the normalizer's.
  ["a cue after a sentence that ends in a curly quote", [`${prose(3, "x")}. Then ‘done.’ And the show is brought to you by Zorblat. ${READ_TAIL}`]],
  ["a cue after a pause of 700 ms", [prose(6, "x"), [`and the show is brought to you by Zorblat. ${READ_TAIL}`, 700]]],
  ["a cue after a pause of 699 ms", [prose(6, "x"), [`and the show is brought to you by Zorblat. ${READ_TAIL}`, 699]]],
  ["a cue after words that are no token", [`${prose(4, "x")}. 🎵 — This 🎉 episode … is brought — to you by Zorblat. ${READ_TAIL}`]],
  ["a cue in capitals with a dotted capital I and a Kelvin sign", [`${prose(4, "x")}. THİS EPİSODE İS BROUGHT TO YOU BY ZORBLAT. ${prose(24, "r")}. BACK TO THE SHOW. ${prose(8, "y")}`]],
  ["a cue and hand-back with curly apostrophes", [`${prose(4, "x")}. Today’s show is sponsored by Zorblat. ${prose(24, "r")}. Onto today’s episode. ${prose(8, "y")}`]],
  ["a cue in title case with punctuation", [`${prose(4, "x")}. "This Episode: Brought To You By... Zorblat!" ${READ_TAIL}`]],
];
for (const [name, parts] of sentenceStarts) add(name, { speech: T(name, blocks(...parts).words), duration_ms: 60_000 });

// Where a read ends: through the end of the hand-back sentence.
const READ_HEAD = `This show is brought to you by Zorblat. ${prose(24, "r")}.`;
const handBacks: [string, (string | [string, number])[], number?][] = [
  ["a hand-back in the middle of a sentence", [`${READ_HEAD} And now back to the show with more from our guest. ${prose(8, "y")}`]],
  ["a hand-back sentence broken by a pause of 700 ms", [`${READ_HEAD} And now back to the show`, [`with more from our guest. ${prose(8, "y")}`, 700]]],
  ["a hand-back sentence with a pause of 699 ms in it", [`${READ_HEAD} And now back to the show`, [`with more from our guest. ${prose(8, "y")}`, 699]]],
  ["a hand-back sentence that ends in a quote", [`${READ_HEAD} "Back to the show." ${prose(8, "y")}`]],
  ["a hand-back sentence that ends in a curly quote runs on", [`${READ_HEAD} ‘Back to the show.’ ${prose(4, "y")}. ${prose(4, "z")}`]],
  ["a hand-back as the last words of the recording", [`${READ_HEAD} Back to the show.`]],
  ["a hand-back as the last words, cut by the duration", [`${READ_HEAD} Back to the show.`], 14_000],
  ["a hand-back followed by three seconds of silence", [`${READ_HEAD} Back to the show.`, [prose(8, "y"), 3_000]]],
  ["a hand-back followed by just over three seconds of silence", [`${READ_HEAD} Back to the show.`, [prose(8, "y"), 3_001]]],
  ["a hand-back with no full stop before the show resumes", [`${READ_HEAD} back to the show ${prose(8, "y")}`]],
  ["two hand-backs: the first ends the read", [`${READ_HEAD} Back to the show. ${prose(4, "y")}. Onto the interview. ${prose(4, "z")}`]],
  ["a hand-back before the cue is ignored", [`Back to the show. ${READ_HEAD} ${prose(4, "y")}. Onto the interview. ${prose(4, "z")}`]],
  ["a hand-back too soon makes a break too short", [`This show is brought to you by Zorblat. ${prose(6, "r")}. Back to the show. ${prose(8, "y")}`]],
];
for (const [name, parts, duration] of handBacks) add(name, { speech: T(name, blocks(...parts).words), duration_ms: duration ?? 60_000 });
add("a short hand-back read counts with a lower shortest break", { speech: "a hand-back too soon makes a break too short", duration_ms: 60_000 }, { min_break_ms: 5_000 });

{
  const one = `This episode is brought to you by Zorblat. ${prose(10, "r")}. Thanks to our sponsor Zorblat for the promo code. ${prose(10, "s")}. Back to the show.`;
  const two = `A quick word from our sponsor Quillfeather. ${prose(26, "q")}. Now back to our conversation.`;
  const b = blocks(one, [`${prose(60, "x")}.`, 500], [two, 500], [prose(30, "y"), 500]);
  const speech = T("a pre-roll with three cues and a mid-roll", b.words);
  add("several cues in one read, and a second read later", { speech, duration_ms: b.end + 5_000 });
  add("the second read first in the chapters", { speech, chapters: [ad(b.starts[2]!, b.starts[3]!), ad(0, b.starts[1]!)], duration_ms: b.end + 5_000 });
  // No full stop or pause between the show and the second read: its sentence runs back to the first read's end.
  const run = blocks(one, [prose(60, "x"), 500], [two, 500], [prose(30, "y"), 500]);
  add("a second read whose sentence runs back to the first merges into it and keeps the first one's end", { speech: T("two reads with unpunctuated speech between", run.words), duration_ms: run.end + 5_000 });
}

{
  const b = blocks(prose(20, "x"), "You could be a sponsor too with a free trial and terms apply for a limited time.", prose(20, "y"));
  add("weak phrases alone start nothing", { speech: T("speech with weak phrases only", b.words), duration_ms: b.end + 5_000 });
}

// ---- Ad chapters -------------------------------------------------------------------------------------------------

add("an ad chapter alone, and implausible ones dropped", { speech: null, chapters: [ad(0, 5_000), ad(5_000, 40_000), ad(40_000, 900_000)], duration_ms: 900_000 });
add("only the kind 'ad' counts", {
  speech: null,
  chapters: [{ start_ms: 0, end_ms: 20_000, kind: "Ad" }, { start_ms: 30_000, end_ms: 50_000, kind: "AD" }, { start_ms: 60_000, end_ms: 80_000, kind: "ads" }, { start_ms: 90_000, end_ms: 110_000, kind: " ad" }, { start_ms: 120_000, end_ms: 140_000, kind: "" }, { start_ms: 150_000, end_ms: 170_000, kind: "content" }, ad(180_000, 200_000)],
  duration_ms: 300_000,
});
add("chapters as short and as long as allowed, exactly", { speech: null, chapters: [ad(0, 10_000), ad(20_000, 29_999), ad(100_000, 460_000), ad(500_000, 860_001)], duration_ms: 1_000_000 });
add("chapters given out of order come back in order", { speech: null, chapters: [ad(200_000, 230_000), ad(0, 30_000), ad(100_000, 130_000)], duration_ms: 300_000 });
add("chapters two seconds apart merge and keep the first one's end", { speech: null, chapters: [ad(10_000, 30_000), ad(32_000, 50_000)], duration_ms: 100_000 });
add("chapters just over two seconds apart stay two breaks", { speech: null, chapters: [ad(10_000, 30_000), ad(32_001, 50_000)], duration_ms: 100_000 });
add("overlapping chapters, the longer one second", { speech: null, chapters: [ad(10_000, 30_000), ad(15_000, 90_000)], duration_ms: 100_000 });
add("overlapping chapters, the longer one first", { speech: null, chapters: [ad(10_000, 90_000), ad(15_000, 30_000)], duration_ms: 100_000 });
add("a chain of chapters, each within two seconds of the last", { speech: null, chapters: [ad(0, 12_000), ad(13_000, 25_000), ad(26_500, 40_000), ad(42_000, 55_000)], duration_ms: 100_000 });
add("a chapter that starts before zero", { speech: null, chapters: [ad(-5_000, 12_000)], duration_ms: 100_000 });
add("a chapter that runs past the end of the recording", { speech: null, chapters: [ad(80_000, 120_000)], duration_ms: 100_000 });
add("a chapter left too short by the end of the recording", { speech: null, chapters: [ad(50_000, 65_000)], duration_ms: 55_000 });
add("a chapter wholly past the end of the recording", { speech: null, chapters: [ad(120_000, 140_000)], duration_ms: 100_000 });
add("a chapter wholly before zero", { speech: null, chapters: [ad(-40_000, -20_000)], duration_ms: 100_000 });
add("a chapter that ends before it starts", { speech: null, chapters: [ad(40_000, 20_000)], duration_ms: 100_000 });
add("a recording of no length", { speech: null, chapters: [ad(0, 30_000)], duration_ms: 0 });
add("a shorter shortest break admits a five second chapter", { speech: null, chapters: [ad(0, 5_000), ad(20_000, 24_999)], duration_ms: 100_000 }, { min_break_ms: 5_000 });
add("a shorter longest break drops a long chapter", { speech: null, chapters: [ad(0, 60_000), ad(100_000, 160_001)], duration_ms: 300_000 }, { max_break_ms: 60_000 });
add("nothing to go on", { speech: null, duration_ms: 100_000 });
add("no chapters", { speech: null, chapters: null, duration_ms: 100_000 });
add("an empty chapter list", { speech: null, chapters: [], duration_ms: 100_000 });
add("an empty transcript and a chapter", { speech: T("empty", []), chapters: [ad(0, 30_000)], duration_ms: 100_000 });
add("an empty transcript and empty publisher text", { speech: "empty", publisher: { transcript: "empty", verbatim: true }, duration_ms: 100_000 });

{
  const read = `Thanks to our sponsor Zorblat. ${prose(60, "r")}`;
  const speech = T("a read inside an ad chapter", [...speak(prose(50, "x"), 0), ...speak(read, 30_000), ...speak(prose(50, "y"), 60_000)]);
  add("an ad chapter's edges, agreeing with a cue inside it", { speech, chapters: [ad(30_000, 59_800), { start_ms: 59_800, end_ms: 80_000, kind: "content" }], duration_ms: 80_000 });
}

// A phrase counts toward a chapter from five seconds before it starts up to, not including, its end.
for (const [name, at] of [["five seconds before the chapter", 25_000], ["just over five seconds before the chapter", 24_999], ["at the chapter's end", 50_000], ["one millisecond before the chapter's end", 49_999]] as [string, number][]) {
  const speech = T(`a weak phrase ${name}`, [...speak(prose(5, "x"), 0), ...speak("use code zorb", at), ...speak(prose(5, "y"), 70_000)]);
  add(`a weak phrase ${name}`, { speech, chapters: [ad(30_000, 50_000)], duration_ms: 100_000 });
}

{
  const speech = T("a weak phrase and then a strong one inside a chapter", [...speak(prose(5, "x"), 0), ...speak("Sign up at zorblat dot com and use the promo code zorb", 31_000), ...speak(prose(5, "y"), 130_000)]);
  add("a strong phrase is the cue even when a weak one comes first", { speech, chapters: [ad(30_000, 50_000)], duration_ms: 140_000 });
  // The same words with the recording ending within 90 s of the cue: its read is a post-roll, and that end beats the chapter's.
  const late = T("a strong phrase inside a chapter near the end of the recording", [...speak(prose(5, "x"), 0), ...speak("Sign up at zorblat dot com and use the promo code zorb", 31_000), ...speak(prose(5, "y"), 70_000)]);
  add("a strong phrase in a chapter within 90 s of the last word runs the break to the end", { speech: late, chapters: [ad(30_000, 50_000)], duration_ms: 100_000 });
}

// ---- Every phrase ------------------------------------------------------------------------------------------------
// Each is spoken at the start of an ad chapter, which reports the phrase it heard (`cue`) or none.

const heard: [string, string | null][] = [
  // "<this|today's|the> [daily|weekly] <kind> [of <name>] [is|was] <brought to you|sponsored|…> by"
  ["This episode is brought to you by", "this episode is brought to you by"],
  ["Today's show was sponsored by", "today's show was sponsored by"],
  ["The podcast supported by", "the podcast supported by"],
  ["This daily update is presented by", "this daily update is presented by"],
  ["The weekly newsletter is powered by", "the weekly newsletter is powered by"],
  ["This interview is underwritten by", "this interview is underwritten by"],
  ["This article was made possible by", "this article was made possible by"],
  ["This post is sponsored by", "this post is sponsored by"],
  ["This essay is supported by", "this essay is supported by"],
  ["This program is brought to you by", "this program is brought to you by"],
  ["This segment is presented by", "this segment is presented by"],
  ["This conversation is brought to you by", "this conversation is brought to you by"],
  ["This episode of Tales is brought to you by", "this episode of tales is brought to you by"],
  ["This episode of Tall Tales was sponsored by", "this episode of tall tales was sponsored by"],
  ["Today's episode of O'Neill's Hour is supported by", "today's episode of o'neill's hour is supported by"],
  ["This episode of The Very Long Name is brought to you by", "brought to you by"],
  ["This episode of a b c is sponsored by", "sponsored by"],
  ["This episode of Studio 9 is sponsored by", "sponsored by"],
  ["This monthly update is presented by", null],
  ["This episode is presented buy", null],
  ["This episode presented by", "this episode presented by"],
  ["This episode is being presented by", null],
  ["These episodes are brought to you by", "brought to you by"],
  ["THIS EPISODE IS BROUGHT TO YOU BY", "this episode is brought to you by"],
  ["this-episode is, brought; to: you by", "brought to you by"],
  ["Brought to you by", "brought to you by"],
  ["brought to you buy", null],
  // "<thanks|thank you> to <our|today's|this week's|this episode's> sponsor[s]"
  ["Thanks to our sponsor", "thanks to our sponsor"],
  ["Thank you to today's sponsors", "thank you to today's sponsors"],
  ["Thanks to this week's sponsor", "thanks to this week's sponsor"],
  ["Thank you to this episode's sponsors", "thank you to this episode's sponsors"],
  ["Thanks to the sponsor", "sponsor"],
  ["Thanks to our sponsorship", null],
  // "[a|one] [quick|short|brief] <word|message|break> from <our|today's|this week's> sponsor[s]"
  ["A quick word from our sponsor", "a quick word from our sponsor"],
  ["One short message from today's sponsors", "one short message from today's sponsors"],
  ["Brief break from this week's sponsor", "brief break from this week's sponsor"],
  ["A word from our sponsors", "a word from our sponsors"],
  ["Message from our sponsor", "message from our sponsor"],
  ["A quick short word from our sponsor", "short word from our sponsor"],
  ["A long word from our sponsor", "word from our sponsor"],
  ["A word from the sponsor", "sponsor"],
  // "support for <this|the> <show|podcast|episode> comes from"
  ["Support for this show comes from", "support for this show comes from"],
  ["Support for the podcast comes from", "support for the podcast comes from"],
  ["Support for this episode comes from", "support for this episode comes from"],
  ["Support for our show comes from", null],
  ["Support for this show came from", null],
  // "our sponsor <today|this week|for this episode>"
  ["Our sponsor today", "our sponsor today"],
  ["Our sponsor this week", "our sponsor this week"],
  ["Our sponsor for this episode", "our sponsor for this episode"],
  ["Our sponsors today", "sponsors"],
  // "today's sponsor"
  ["Today's sponsor", "today's sponsor"],
  ["Today’s Sponsor", "today's sponsor"],
  ["Todays sponsor", "sponsor"],
  // "<presenting|title|exclusive> sponsor"
  ["Presenting sponsor", "presenting sponsor"],
  ["Title sponsor", "title sponsor"],
  ["Exclusive sponsor", "exclusive sponsor"],
  ["Our presenting sponsors", "sponsors"],
  // "<promo|discount|coupon> code"
  ["Promo code", "promo code"],
  ["Discount code", "discount code"],
  ["Coupon code", "coupon code"],
  ["Promo codes", null],
  ["Promocode", null],
  // Weak phrases: they confirm a break and never start one.
  ["Sponsored by", "sponsored by"],
  ["Sponsored", null],
  ["Sponsor", "sponsor"],
  ["Sponsors", "sponsors"],
  ["The sponsor's offer", "sponsor"],
  ["Sponsorship", null],
  ["Co-sponsor", null],
  ["Rock'n'sponsors", "sponsors"],
  ["Use code", "use code"],
  ["Use the code", "use the code"],
  ["Use my code", null],
  ["Used code", null],
  ["Free trial", "free trial"],
  ["Free trials", null],
  ["First month free", "first month free"],
  ["First week free", "first week free"],
  ["1st month free", "1st month free"],
  ["1st week free", "1st week free"],
  ["First year free", null],
  ["20 percent off", "20 percent off"],
  ["5 percent off", "5 percent off"],
  ["Get 100 percent off", "100 percent off"],
  ["Twenty percent off", null],
  ["20% off", null],
  ["٢٠ percent off", null], // Arabic-Indic digits are no token
  ["Sign up at zorblat dot com", "sign up at zorblat dot com"],
  ["Get started today at zorblat dot com", "get started today at zorblat dot com"],
  ["Head over to zorblat dot ai", "head over to zorblat dot ai"],
  ["Go now to zorblat dot io", "go now to zorblat dot io"],
  ["Go to zorblat.com", "go to zorblatcom"],
  ["Go to zorblat co", "go to zorblat co"],
  ["Sign up today to zorblatdotcom", "sign up today to zorblatdotcom"],
  ["Go to zorblat dot net", null],
  ["Go to the store", null],
  // The address rule also matches ordinary words that end like one.
  ["Go to Mexico", "go to mexico"],
  ["Go to Ohio", "go to ohio"],
  ["Terms apply", "terms apply"],
  ["Terms and conditions apply", "terms and conditions apply"],
  ["Terms may apply", null],
  ["Limited time", "limited time"],
  ["Limited-time", null],
  ["Nothing of the kind", null],
];
const phraseCases = heard.map(([spoken, cue], i) => {
  const name = `phrase ${String(i + 1).padStart(3, "0")}: ${spoken}`;
  add(name, { speech: T(name, speak(`${spoken} Zorblat ${prose(5, "f")}`, 0)), chapters: [ad(0, 30_000)], duration_ms: 60_000 });
  return { name, cue };
});

// Each hand-back line is spoken after a read that has no other end; a line the detector knows ends the break there.
const handBackLines: [string, boolean][] = [
  ["On the show.", true],
  ["Onto the update.", true],
  ["On to today's episode.", true],
  ["Onto the interview.", true],
  ["On to the article.", true],
  ["Onto today’s show.", true],
  ["On the podcast.", false],
  ["Onto our show.", false],
  ["Back to the show.", true],
  ["And back to our episode.", true],
  ["Now back to the interview.", true],
  ["And now back to our conversation.", true],
  ["Back to the update.", true],
  ["Back to our program.", true],
  ["Back to the podcast.", false],
  ["Back to my show.", false],
  ["Back in the show.", false],
  ["And now on to the show.", true],
  ["And now back with the show.", true],
  ["And now on with the show.", true],
  ["On with the show.", false],
  ["And now for the show.", false],
];
const handBackCases = handBackLines.map(([line, known], i) => {
  const name = `hand-back ${String(i + 1).padStart(2, "0")}: ${line}`;
  add(name, { speech: T(name, speak(`This show is brought to you by Zorblat. ${prose(16, "r")}. ${line} ${prose(7, "y")}`, 0)), duration_ms: 60_000 });
  return { name, known };
});

function buildCases() {
  return cases.map((c) => {
    const read = (name: string) => fromApiTranscript(transcripts[name]!);
    const { speech, publisher, chapters, duration_ms } = c.input;
    const expect = detectAds(
      {
        speech: speech === null ? null : read(speech),
        ...(publisher === undefined ? {} : { publisher: publisher === null ? null : { transcript: read(publisher.transcript), verbatim: publisher.verbatim } }),
        ...(chapters === undefined ? {} : { chapters }),
        duration_ms,
      },
      c.options ?? {},
    );
    return { name: c.name, input: c.input, options: c.options ?? {}, expect };
  });
}

describe("ads_v3 golden cases", () => {
  const built = buildCases();
  const by = new Map(built.map((c) => [c.name, c.expect]));
  const of = (name: string): AdBreak[] => {
    const found = by.get(name);
    if (!found) throw new Error(`no case named ${name}`);
    return found;
  };
  const spans = (name: string) => of(name).map((b) => [b.start_ms, b.end_ms]);

  it("have unique names", () => {
    expect(by.size).toBe(built.length);
  });

  it("behave as intended", () => {
    expect(of("publisher gap with a sponsor phrase, verbatim text")).toEqual([{ start_ms: T1, end_ms: T2 - 100, confidence: "high", sources: ["publisher_gap", "sponsor_phrase"], cue: "this episode is brought to you by" }]);
    expect(of("publisher gap alone, edited text")).toEqual([]);
    expect(of("publisher gap alone, verbatim text")).toEqual([{ start_ms: T1, end_ms: T2 - 100, confidence: "medium", sources: ["publisher_gap"], cue: null }]);
    expect(of("publisher gap alone, edited text, confirmed by an ad chapter").map((b) => b.sources)).toEqual([["publisher_gap", "ad_chapter"]]);
    expect(of("a lone gap exactly as long as the lone-gap minimum")).toHaveLength(1);
    expect(of("a lone gap one millisecond short of the lone-gap minimum")).toEqual([]);
    expect(of("a run of unmatched speech exactly as long as the gap minimum")).toHaveLength(1);
    expect(of("a run of unmatched speech one millisecond short of the gap minimum")).toEqual([]);
    expect(of("a short passage such as the intro line is no gap")).toEqual([]);
    expect(of("a short passage counts once the minimums are lowered")).toHaveLength(1);
    expect(of("an island of matched words joins two runs into one gap")).toHaveLength(1);
    expect(of("no islands allowed: two short gaps, neither counts alone")).toEqual([]);
    expect(of("a run with too small a share unmatched is no gap")).toEqual([]);
    expect(of("the same run with a lower share required")).toHaveLength(1);
    expect(of("the same run with the share it has exactly")).toHaveLength(1);
    expect(of("a weak phrase confirms a gap in edited text")[0]).toMatchObject({ confidence: "high", sources: ["publisher_gap", "sponsor_phrase"], cue: "use code" });
    expect(of("gap, sponsor read and ad chapter agree: the gap gives both edges")[0]).toMatchObject({ confidence: "high", sources: ["publisher_gap", "sponsor_phrase", "ad_chapter"] });
    expect(of("a sponsor read the article prints too, with a chapter cut mid-sentence")[0]).toMatchObject({ sources: ["sponsor_phrase", "ad_chapter"], cue: "this update is presented by" });
    expect(of("words that are no token are skipped by the aligner, not by the clock")).toHaveLength(1);
    // With nothing to align against there is no gap; the read is still heard, and runs to the end as a post-roll.
    expect(of("publisher text with no usable words").map((b) => b.sources)).toEqual([["sponsor_phrase"]]);

    expect(of("a sponsor read ends on its hand-back line")[0]).toMatchObject({ confidence: "medium", sources: ["sponsor_phrase"] });
    expect(spans("a music sting")).toEqual([[0, 19_200]]);
    expect(spans("a sting labelled JINGLE")).toEqual([[0, 19_200]]);
    expect(spans("a label that only contains the letters: testing")).toEqual([[0, 19_200]]);
    // No sting: the read ends on the five second pause, just after its last word.
    expect(spans("a label that is not a sting: applause")).toEqual([[0, 15_400]]);
    expect(spans("a label with a long s is not music")).toEqual([[0, 15_400]]);
    expect(spans("a label with a dotted capital I is not music")).toEqual([[0, 15_400]]);
    expect(spans("a sting that starts during the next word")).toEqual([[0, 15_400]]);
    expect(spans("a sting too early in the read")).toEqual([[0, 15_400]]);
    expect(spans("a sting 10.3 seconds in")).toEqual([[0, 10_390]]);
    expect(spans("a sting exactly the shortest break into the read")).toEqual([[0, 10_390]]);
    expect(spans("a sting one millisecond short of the shortest break into the read")).toEqual([[0, 15_400]]);
    expect(spans("a read that ends on a pause resumes just before the next word")).toEqual([[0, 19_800]]);
    expect(spans("a read that ends on a long pause resumes just after its last word")).toEqual([[0, 18_200]]);
    expect(spans("a pause of exactly the read-end pause")).toEqual([[0, 19_300]]);
    expect(of("a pause one millisecond short of the read-end pause")).toEqual([]);
    expect(spans("a shorter read-end pause")).toEqual([[0, 19_299]]);
    expect(spans("a pause-ended read with an ad chapter: the chapter's end wins")).toEqual([[0, 30_000]]);
    expect(spans("an early sting counts once the shortest break is lowered")).toEqual([[0, 5_590]]);
    expect(spans("a sting long after the last word")).toEqual([[0, 64_000]]);
    expect(of("a read with no end is left alone")).toEqual([]);
    expect(spans("a longer longest read and post-roll take it to the end")).toEqual([[0, 200_000]]);
    expect(of("a pause before the minimum read length does not end it")).toHaveLength(1);
    expect(spans("a pause after a read of exactly the minimum length ends it")).toEqual([[0, 16_900]]);
    expect(of("a pause after a read one millisecond short of the minimum does not")).toEqual([]);
    expect(spans("a hand-back that starts at the longest read exactly")).toEqual([[0, 121_500]]);
    expect(of("a hand-back that starts one millisecond past the longest read")).toEqual([]);
    expect(of("a pause-ended read followed by a hand-back read: the hand-back read gives the end and the cue")).toMatchObject([{ start_ms: 0, cue: "thanks to our sponsor" }]);
    expect(of("a pause-ended read followed by a hand-back read: the hand-back read gives the end and the cue")[0]!.end_ms).toBeGreaterThan(30_000);
    expect(of("a lower minimum read length ends it there, too short to be a break")).toEqual([]);
    expect(of("a post-roll read runs to the end, from its cue's sentence")[0]).toMatchObject({ confidence: "high", sources: ["sponsor_phrase", "ad_chapter"], cue: "this article was presented by" });
    expect(of("a cue far from the end is not a post-roll")).toEqual([]);
    expect(of("a read to the end, 14999 ms long")).toEqual([]);
    expect(spans("a read to the end, 15000 ms long")).toEqual([[0, 16_000]]);
    expect(spans("a read to the end, 90000 ms long")).toEqual([[0, 91_000]]);
    expect(of("a read to the end, 90001 ms long")).toEqual([]);
    expect(of("a pre-roll ends at 'onto the update'")[0]!.start_ms).toBe(0);
    expect(of("a cue after a pause of 700 ms")[0]!.start_ms).toBe(3_000);
    expect(of("a cue after a pause of 699 ms")[0]!.start_ms).toBe(0);
    expect(of("a hand-back sentence broken by a pause of 700 ms")[0]!.end_ms).toBeLessThan(of("a hand-back sentence with a pause of 699 ms in it")[0]!.end_ms);
    expect(of("a hand-back followed by three seconds of silence")[0]!.end_ms).toBe(of("a hand-back followed by just over three seconds of silence")[0]!.end_ms + 2_600);
    expect(of("a cue after a sentence that ends in a curly quote")[0]!.start_ms).toBeLessThan(of("a cue after a sentence that ends in a quote")[0]!.start_ms);
    expect(of("a cue in capitals with a dotted capital I and a Kelvin sign")[0]).toMatchObject({ cue: "this episode is brought to you by" });
    expect(of("a cue after words that are no token")[0]).toMatchObject({ cue: "this episode is brought to you by" });
    expect(of("a hand-back too soon makes a break too short")).toEqual([]);
    expect(of("several cues in one read, and a second read later").map((b) => b.cue)).toEqual(["this episode is brought to you by", "a quick word from our sponsor"]);
    expect(of("a second read whose sentence runs back to the first merges into it and keeps the first one's end")).toEqual([of("several cues in one read, and a second read later")[0]]);
    expect(of("weak phrases alone start nothing")).toEqual([]);

    expect(of("an ad chapter alone, and implausible ones dropped")).toEqual([{ start_ms: 5_000, end_ms: 40_000, confidence: "medium", sources: ["ad_chapter"], cue: null }]);
    expect(spans("only the kind 'ad' counts")).toEqual([[180_000, 200_000]]);
    expect(spans("chapters as short and as long as allowed, exactly")).toEqual([[0, 10_000], [100_000, 460_000]]);
    expect(spans("chapters given out of order come back in order")).toEqual([[0, 30_000], [100_000, 130_000], [200_000, 230_000]]);
    expect(spans("chapters two seconds apart merge and keep the first one's end")).toEqual([[10_000, 30_000]]);
    expect(spans("chapters just over two seconds apart stay two breaks")).toEqual([[10_000, 30_000], [32_001, 50_000]]);
    expect(spans("a chapter that starts before zero")).toEqual([[0, 12_000]]);
    expect(spans("a chapter that runs past the end of the recording")).toEqual([[80_000, 100_000]]);
    expect(of("a recording of no length")).toEqual([]);
    expect(of("an ad chapter's edges, agreeing with a cue inside it")).toEqual([{ start_ms: 30_000, end_ms: 59_800, confidence: "high", sources: ["sponsor_phrase", "ad_chapter"], cue: "thanks to our sponsor" }]);
    expect(of("a weak phrase five seconds before the chapter")[0]!.cue).toBe("use code");
    expect(of("a weak phrase just over five seconds before the chapter")[0]!.cue).toBeNull();
    expect(of("a weak phrase at the chapter's end")[0]!.cue).toBeNull();
    expect(of("a weak phrase one millisecond before the chapter's end")[0]!.cue).toBe("use code");
    expect(of("a strong phrase is the cue even when a weak one comes first")).toEqual([{ start_ms: 30_000, end_ms: 50_000, confidence: "high", sources: ["sponsor_phrase", "ad_chapter"], cue: "promo code" }]);
    expect(spans("a strong phrase in a chapter within 90 s of the last word runs the break to the end")).toEqual([[30_000, 100_000]]);
  });

  it("hear every phrase, and only those", () => {
    for (const { name, cue } of phraseCases) {
      expect(of(name), name).toEqual([{ start_ms: 0, end_ms: 30_000, confidence: cue === null ? "medium" : "high", sources: cue === null ? ["ad_chapter"] : ["sponsor_phrase", "ad_chapter"], cue }]);
    }
    for (const { name, known } of handBackCases) {
      if (known) {
        expect(of(name), name).toHaveLength(1);
        expect(of(name)[0]!.end_ms, name).toBeLessThan(15_000);
      } else expect(of(name), name).toEqual([]);
    }
  });

  it("cover every source, alone and together, at both confidences", () => {
    const seen = new Set(built.flatMap((c) => c.expect.map((b) => `${b.confidence}: ${b.sources.join("+")}`)));
    expect([...seen].sort()).toEqual([
      "high: publisher_gap+ad_chapter",
      "high: publisher_gap+sponsor_phrase",
      "high: publisher_gap+sponsor_phrase+ad_chapter",
      "high: sponsor_phrase+ad_chapter",
      "medium: ad_chapter",
      "medium: publisher_gap",
      "medium: sponsor_phrase",
    ]);
    const used = new Set(built.flatMap((c) => Object.keys(c.options)));
    expect([...used].sort()).toEqual(Object.keys(DEFAULT_AD_OPTIONS).sort());
  });

  it("match the committed file", () => {
    const file = {
      family: "ads",
      version: AD_DETECTOR_VERSION,
      reference: ["server/src/core/ads/detect.ts", "server/src/core/transcript/align.ts", "server/src/core/transcript/tokens.ts"],
      default_options: DEFAULT_AD_OPTIONS,
      transcripts,
      cases: built,
    };
    expect(golden(`ads/${AD_DETECTOR_VERSION}.json`, file)).toEqual(JSON.parse(JSON.stringify(file)));
  });
});
