/**
 * Golden cases for the snip-summary step that does not involve a model: building the excerpt's sentences and
 * context (core/summary/input.ts), validating a model's answer (core/summary/snip.ts, names.ts), the fallback
 * title, and sentence counting. Problem strings are compared exactly: they are fed back to the model on retry,
 * so a port that words them differently changes the prompt.
 */
import { describe, expect, it } from "vitest";
import { precedingSentences, sentencesForRange } from "../src/core/summary/input.js";
import { isTitleCase, unsupportedNames } from "../src/core/summary/names.js";
import { countSentences, DEFAULT_SNIP_SUMMARY_STYLE, fallbackTitle, validateSnipSummary, type SnipSummaryInput, type SnipSummaryOutput } from "../src/core/summary/snip.js";
import { toApiTranscript } from "../src/core/transcript/types.js";
import { golden } from "./helpers/golden.js";
import { buildTranscript, conversation } from "./helpers/transcript.js";

const transcript = buildTranscript([
  { speaker: "A", text: "Welcome back. Today Marcus Webb joins us to talk about pricing." },
  { speaker: "A", text: "So what did you try first?", pause_ms: 600 },
  { speaker: "B", text: "The first thing we tried was a flat monthly fee for everyone. It felt simple and fair. We ran it for three months and almost nobody upgraded.", pause_ms: 1_200 },
  { speaker: "A", text: "Right.", pause_ms: 400 },
  { speaker: "B", text: "So we switched to usage based pricing and revenue doubled in a quarter. José on our team saw it first.", pause_ms: 300 },
]);
const long = conversation(9, 4);

const inputCases = [
  { transcript: "short", start_word: 0, end_word: transcript.word_count },
  { transcript: "short", start_word: 12, end_word: 50 },
  { transcript: "short", start_word: 15, end_word: 16 },
  { transcript: "short", start_word: 30, end_word: transcript.word_count },
  { transcript: "long", start_word: 100, end_word: 260 },
  { transcript: "long", start_word: 0, end_word: 40 },
].map((c) => {
  const t = c.transcript === "short" ? transcript : long;
  return { ...c, expect: { excerpt: sentencesForRange(t, c.start_word, c.end_word), preceding: precedingSentences(t, c.start_word, 2) } };
});

const excerpt = sentencesForRange(transcript, 18, transcript.word_count);
const input: SnipSummaryInput = { excerpt, context: { show_title: "Pricing Talk", episode_title: "Flat fees", preceding: precedingSentences(transcript, 18, 2) } };
const good: SnipSummaryOutput = {
  title: "A flat fee nobody upgraded from",
  summary: "The guest says almost nobody upgraded under a flat fee. Usage based pricing doubled revenue.",
  claims: [{ text: "Nobody upgraded.", sentence_ids: [1] }, { text: "Revenue doubled.", sentence_ids: [3] }],
};
const outputs: [string, SnipSummaryOutput][] = [
  ["valid", good],
  ["title over 60", { ...good, title: "A flat monthly fee that almost nobody ever upgraded from, in the end" }],
  ["title at 60 counted in UTF-16 units", { ...good, title: `${"a".repeat(58)}🙂` }],
  ["summary over 320", { ...good, summary: `${"The guest says pricing matters a great deal to everyone involved here. ".repeat(5)}` }],
  ["four sentences", { ...good, summary: "The guest tried a flat fee. Nobody upgraded. They switched. Revenue doubled.", claims: [1, 2, 3, 4].map((i) => ({ text: "c", sentence_ids: [i % 4] })) }],
  ["refers to this clip", { ...good, summary: "In this clip the guest explains the flat fee." }],
  ["refers to this excerpt in the title", { ...good, title: "In this excerpt: flat fees" }],
  ["cites a missing sentence", { ...good, claims: [{ text: "x", sentence_ids: [99] }, { text: "y", sentence_ids: [1] }] }],
  ["fewer claims than sentences", { ...good, claims: [{ text: "x", sentence_ids: [1] }] }],
  ["unsupported name", { ...good, summary: "Sarah says almost nobody upgraded under a flat fee. Usage pricing doubled revenue." }],
  ["name from the excerpt is fine", { ...good, summary: "The guest says José saw it first. Usage pricing doubled revenue." }],
  ["name from the preceding context is not allowed", { ...good, summary: "Marcus says nobody upgraded. Usage pricing doubled revenue." }],
  ["title case title skips the name check on the title", { ...good, title: "Why Flat Fees Fail" }],
  ["sentence-initial name with a verb of saying", { ...good, summary: "Priya said nobody upgraded. Usage pricing doubled revenue." }],
  ["empty title", { ...good, title: " " }],
  ["non-breaking space in summary", { ...good, summary: "The guest says almost nobody upgraded. Usage pricing doubled revenue." }],
  ["curly apostrophe name", { ...good, summary: "The guest’s team at O’Neill saw it. Usage pricing doubled revenue." }],
];
const validation = outputs.map(([name, output]) => ({ name, output, expect: validateSnipSummary(output, input, DEFAULT_SNIP_SUMMARY_STYLE) }));

const titleTexts = ["The first thing we tried was a flat monthly fee for everyone.", "Right.", "So, we switched to usage based pricing and, frankly,", "One two three four five six seven eight", "One two three four five six seven, eight nine"];
const fallback = titleTexts.map((text) => ({ excerpt_texts: [text], expect: fallbackTitle([{ id: 0, speaker: null, start_word: 0, end_word: 1, start_ms: 0, end_ms: 1, text, word_count: 1 }]) }));
fallback.push({ excerpt_texts: excerpt.map((s) => s.text), expect: fallbackTitle(excerpt) });

const sentenceTexts = ["One thing. Another thing? Yes!", "Costs rose 3.5 percent last year.", "He said “stop.” Then he left.", "No terminal punctuation", "Dr. Smith arrived. He sat.", "Wait… what? OK."];
const counting = sentenceTexts.map((text) => ({ text, expect: countSentences(text) }));

const nameCases = [
  { texts: ["Marcus explains the fee."], allowed: ["The guest explains the fee."] },
  { texts: ["The guest says Marcus left."], allowed: ["Marcus left the company.", "host guest"] },
  { texts: ["Why Flat Fees Fail"], allowed: [""] },
  { texts: ["The host and the Guest agree."], allowed: ["host guest"] },
  { texts: ["Élodie said yes."], allowed: ["no names here"] },
].map((c) => ({ ...c, expect: unsupportedNames(c.texts, c.allowed) }));
const titleCase = ["Why Flat Fees Fail", "Why flat fees fail", "The Art of the Deal", "A", "iPhone Sales Rise"].map((title) => ({ title, expect: isTitleCase(title) }));

describe("snip summary golden cases", () => {
  it("behave as intended", () => {
    const by = Object.fromEntries(validation.map((v) => [v.name, v.expect]));
    expect(by["valid"]).toEqual([]);
    expect(by["name from the excerpt is fine"]).toEqual([]);
    expect(by["unsupported name"]).toEqual([expect.stringMatching(/names not found.*Sarah/)]);
    expect(by["title at 60 counted in UTF-16 units"]).toEqual([]); // 58 + an emoji (2 units) = 60
    expect(by["fewer claims than sentences"]).toEqual([expect.stringMatching(/2 sentences but only 1 claims/)]);
  });

  it("match the committed file", () => {
    const file = {
      family: "summary",
      version: "snip_summary_validation_v1",
      reference: ["server/src/core/summary/input.ts", "server/src/core/summary/snip.ts", "server/src/core/summary/names.ts"],
      style: DEFAULT_SNIP_SUMMARY_STYLE,
      transcripts: { short: toApiTranscript(transcript), long: toApiTranscript(long) },
      input: inputCases,
      validation: { input, cases: validation },
      fallback_title: fallback,
      count_sentences: counting,
      unsupported_names: nameCases,
      is_title_case: titleCase,
    };
    expect(golden("summary/snip_summary_validation_v1.json", file)).toEqual(JSON.parse(JSON.stringify(file)));
  });
});
