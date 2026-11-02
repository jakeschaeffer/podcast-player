/**
 * Golden cases for the bulleted snip summary (snip-summary v3 and later): the validator's problem strings, which are
 * fed back to the model on retry, the bullet clean-up, and the key the word-for-word quote check compares. The
 * excerpt-building, fallback-title and name-guard cases are unchanged and stay in snip_summary_validation_v1.json.
 */
import { describe, expect, it } from "vitest";
import { precedingSentences, sentencesForRange } from "../src/core/summary/input.js";
import { cleanBullet, DEFAULT_SNIP_BULLETS_STYLE, quoteKey, validateSnipBullets, type SnipBulletsOutput, type SnipSummaryInput } from "../src/core/summary/snip.js";
import { golden } from "./helpers/golden.js";
import { buildTranscript } from "./helpers/transcript.js";

const transcript = buildTranscript([
  { speaker: "A", text: "Welcome back. Today Marcus Webb joins us to talk about pricing." },
  { speaker: "A", text: "So what did you try first?", pause_ms: 600 },
  { speaker: "B", text: "The first thing we tried was a flat monthly fee for everyone. It felt simple and fair. We ran it for three months and almost nobody upgraded.", pause_ms: 1_200 },
  { speaker: "A", text: "Right.", pause_ms: 400 },
  { speaker: "B", text: "So we switched to usage based pricing and revenue doubled in a quarter. José on our team saw it first.", pause_ms: 300 },
]);
const excerpt = sentencesForRange(transcript, 18, transcript.word_count);
const input: SnipSummaryInput = { excerpt, context: { show_title: "Pricing Talk", episode_title: "Flat fees", preceding: precedingSentences(transcript, 18, 2) } };
const good: SnipBulletsOutput = {
  title: "A flat fee nobody upgraded from",
  bullets: [
    { text: "A flat monthly fee for everyone comes first.", sentence_ids: [0] },
    { text: "Almost nobody upgrades in three months.", sentence_ids: [2] },
    { text: "Usage based pricing doubles revenue in a quarter.", sentence_ids: [4] },
  ],
  quote: "We ran it for three months and almost nobody upgraded.",
};
const outputs: [string, SnipBulletsOutput][] = [
  ["valid", good],
  ["no quote", { ...good, quote: "" }],
  ["quote with a filler word left out", { ...good, quote: "So we switched to usage based pricing and revenue doubled" }],
  ["quote with curly punctuation", { ...good, quote: "It felt simple and fair — we ran it for three months" }],
  ["quote not in the excerpt", { ...good, quote: "We ran it for six months and everybody upgraded." }],
  ["quote too short", { ...good, quote: "Right." }],
  ["quote too long", { ...good, quote: `${"We ran it for three months and almost nobody upgraded. ".repeat(5).trim()}` }],
  ["six bullets", { ...good, bullets: [...good.bullets, ...good.bullets] }],
  ["bullet over 140", { ...good, bullets: [{ text: `${"Usage pricing doubles revenue ".repeat(5)}`.trim(), sentence_ids: [4] }] }],
  ["bullet at 140 counted in UTF-16 units", { ...good, bullets: [{ text: `${"a".repeat(138)}🙂`, sentence_ids: [4] }] }],
  ["empty bullet", { ...good, bullets: [{ text: " ", sentence_ids: [4] }] }],
  ["leading dash is cleaned", { ...good, bullets: [{ text: "- Usage pricing doubles revenue.", sentence_ids: [4] }] }],
  ["bullet cites a missing sentence", { ...good, bullets: [{ text: "Revenue doubles.", sentence_ids: [99] }] }],
  ["refers to this clip", { ...good, bullets: [{ text: "In this clip a flat fee fails.", sentence_ids: [0] }] }],
  ["unsupported name", { ...good, bullets: [{ text: "Nobody upgrades, Sarah says.", sentence_ids: [2] }] }],
  ["name from the excerpt is fine", { ...good, bullets: [{ text: "José on the team sees it first.", sentence_ids: [5] }] }],
  ["title over 60", { ...good, title: "A flat monthly fee that almost nobody ever upgraded from, in the end" }],
];
const validation = outputs.map(([name, output]) => ({ name, output, expect: validateSnipBullets(output, input, DEFAULT_SNIP_BULLETS_STYLE) }));
const bulletTexts = ["- A dash", "• A dot", "* A star", "– An en dash", "-Not a list marker", "Plain"];
const cleaning = bulletTexts.map((text) => ({ text, expect: cleanBullet(text) }));
const quoteTexts = ["It’s “simple”,  uh, fair", "We ran it — for three months!", "Um, Revenue DOUBLED.", "José’s team"];
const keys = quoteTexts.map((text) => ({ text, expect: quoteKey(text) }));

describe("bulleted snip summary golden cases", () => {
  it("behave as intended", () => {
    const by = Object.fromEntries(validation.map((v) => [v.name, v.expect]));
    for (const ok of ["valid", "no quote", "quote with a filler word left out", "quote with curly punctuation", "leading dash is cleaned", "name from the excerpt is fine", "bullet at 140 counted in UTF-16 units"]) {
      expect(by[ok], ok).toEqual([]);
    }
    expect(by["quote not in the excerpt"]).toEqual([expect.stringMatching(/not word for word/)]);
    expect(by["six bullets"]).toEqual([expect.stringMatching(/6 bullets; max 5/)]);
    expect(by["unsupported name"]).toEqual([expect.stringMatching(/names not found.*Sarah/)]);
  });

  it("match the committed file", () => {
    const file = {
      family: "summary",
      version: "snip_summary_validation_v2",
      reference: ["server/src/core/summary/snip.ts", "server/src/core/summary/names.ts"],
      style: DEFAULT_SNIP_BULLETS_STYLE,
      validation: { input, cases: validation },
      clean_bullet: cleaning,
      quote_key: keys,
    };
    expect(golden("summary/snip_summary_validation_v2.json", file)).toEqual(JSON.parse(JSON.stringify(file)));
  });
});
