/**
 * Golden cases for span selection: sentencizer_v1 (core/snip/sentencize.ts), select_v2 without a model
 * (core/snip/select.ts), and the midpoint word-range rule. Transcripts are synthetic and stored in the API shape
 * (`GET /v1/transcripts/{id}`), which is what a port reads. A port must reproduce every expected value.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_SELECT_PREFS, SELECTOR_VERSION, selectSpan, wordRangeByMidpoint, type Selection } from "../src/core/snip/select.js";
import { SENTENCIZER_VERSION, sentencize, type SentencizeOptions } from "../src/core/snip/sentencize.js";
import { toApiTranscript, type NormalizedTranscript } from "../src/core/transcript/types.js";
import { golden } from "./helpers/golden.js";
import { buildTranscript, conversation, lcg, type Turn } from "./helpers/transcript.js";

const interview: Turn[] = [
  { speaker: "A", text: "Welcome back to the show. Today we talk about pricing." },
  { speaker: "A", text: "So what did you try first?", pause_ms: 600 },
  { speaker: "B", text: "The first thing we tried was a flat monthly fee for everyone. It felt simple and fair. We ran it for three months and almost nobody upgraded. The problem was that heavy users paid the same as light users.", pause_ms: 1_200 },
  { speaker: "A", text: "Right.", pause_ms: 400 },
  { speaker: "B", text: "So we switched to usage based pricing and revenue doubled in a quarter. That was the moment we understood the product.", pause_ms: 300 },
  { speaker: "A", text: "Here's the thing I keep coming back to. Why did nobody notice sooner?", pause_ms: 1_800 },
  { speaker: "B", text: "Because the dashboard showed signups, not usage. And signups looked great.", pause_ms: 900 },
];

function narrator(seed: number, paragraphs: number): NormalizedTranscript {
  const r = lcg(seed);
  const words = ["the", "house", "stood", "at", "the", "end", "of", "a", "long", "road", "and", "nobody", "had", "lived", "there", "for", "years", "she", "said", "quietly"];
  const turns: Turn[] = [];
  for (let p = 0; p < paragraphs; p++) {
    const sentences: string[] = [];
    for (let s = 0; s < 3 + Math.floor(r() * 4); s++) {
      const n = 6 + Math.floor(r() * 30);
      const ws = Array.from({ length: n }, () => words[Math.floor(r() * words.length)]!);
      ws[0] = ws[0]![0]!.toUpperCase() + ws[0]!.slice(1);
      if (n > 15 && r() < 0.5) ws[Math.floor(n / 2)] += ",";
      sentences.push(`${ws.join(" ")}${r() < 0.1 ? "?" : "."}`);
    }
    turns.push({ text: sentences.join(" "), pause_ms: 900 + Math.floor(r() * 1_500), wps: 2.4 });
  }
  return buildTranscript(turns);
}

/** The same narration with every punctuation mark removed: sentences can only split on pauses. */
function unpunctuated(t: NormalizedTranscript): NormalizedTranscript {
  const strip = (s: string) => s.replace(/[.,!?;:…"]/g, "");
  return { ...t, segments: t.segments.map((s) => ({ ...s, text: strip(s.text), words: s.words.map(([a, b, w]) => [a, b, strip(w)] as [number, number, string]) })) };
}

/** Speech separated by long silences, with short fragments. */
const sparse: Turn[] = [
  { speaker: "A", text: "Okay.", pause_ms: 500 },
  { speaker: "A", text: "We are back after a long break and the first topic is the budget for next year.", pause_ms: 40_000 },
  { speaker: "B", text: "Yes.", pause_ms: 15_000 },
  { speaker: "B", text: "The budget grew by a third. Most of it went to hiring.", pause_ms: 800 },
  { speaker: "A", text: "Uh huh.", pause_ms: 300 },
  { speaker: "B", text: "And that is where the trouble started.", pause_ms: 25_000 },
];

const transcripts: Record<string, NormalizedTranscript> = {
  interview: buildTranscript(Array.from({ length: 4 }, () => interview).flat()),
  narrator: narrator(11, 18),
  narrator_unpunctuated: unpunctuated(narrator(11, 18)),
  sparse: buildTranscript(sparse),
  conversation: conversation(5, 7),
};
const durationOf = (t: NormalizedTranscript) => t.segments[t.segments.length - 1]!.end_ms + 5_000;

type SelectCase = { transcript: string; anchor_ms: number; heard_from_ms: number; duration_ms: number; expect: ReturnType<typeof compact> };
type SentencizeCase = { transcript: string; options: SentencizeOptions; expect: ReturnType<typeof sentencize> };
type WordRangeCase = { transcript: string; start_ms: number; end_ms: number; expect: ReturnType<typeof wordRangeByMidpoint> };

/** Everything a port must reproduce: the span, the method, and the decision record (sentences by id only). */
function compact(s: Selection) {
  return {
    method: s.method, start_ms: s.start_ms, end_ms: s.end_ms, start_word: s.start_word, end_word: s.end_word, window: s.window,
    eligible_end_ids: s.eligible_end_ids, snap: s.snap, chosen: s.chosen,
    candidates: s.candidates.map((c) => ({ start_id: c.start_id, end_id: c.end_id, duration_ms: c.duration_ms, distance_ms: c.distance_ms })),
    sentence_ids: s.sentences.map((x) => ({ id: x.id, start_word: x.start_word, end_word: x.end_word, eligible: x.eligible })),
    version: s.version,
  };
}

async function buildCases() {
  const select: SelectCase[] = [];
  const sentencizeCases: SentencizeCase[] = [];
  const wordRange: WordRangeCase[] = [];
  for (const [name, t] of Object.entries(transcripts)) {
    const duration = durationOf(t);
    sentencizeCases.push({ transcript: name, options: {}, expect: sentencize(t) });
    sentencizeCases.push({ transcript: name, options: { from_ms: duration * 0.4, to_ms: duration * 0.6 }, expect: sentencize(t, { from_ms: duration * 0.4, to_ms: duration * 0.6 }) });
    const r = lcg(name.length * 31);
    const anchors = [0, 5_000, 29_000, 60_000, 95_000, duration * 0.5, duration - 6_000, duration, ...Array.from({ length: 10 }, () => Math.floor(r() * duration))].map(Math.round);
    for (const anchor of anchors) {
      for (const heardFrom of [0, Math.max(0, anchor - 20_000), Math.max(0, anchor - 120_000), anchor]) {
        const selection = await selectSpan({ transcript: t, anchor_ms: anchor, heard_from_ms: heardFrom, duration_ms: duration });
        select.push({ transcript: name, anchor_ms: anchor, heard_from_ms: heardFrom, duration_ms: duration, expect: compact(selection) });
      }
    }
    for (let i = 0; i < 8; i++) {
      const a = Math.floor(r() * duration);
      const b = Math.min(duration, a + Math.floor(r() * 60_000));
      wordRange.push({ transcript: name, start_ms: a, end_ms: b, expect: wordRangeByMidpoint(t, a, b) });
    }
  }
  return { select, sentencize: sentencizeCases, word_range: wordRange };
}

describe("select_v2 golden cases", () => {
  it("cover every method and match the committed file", async () => {
    const cases = await buildCases();
    const methods = new Set(cases.select.map((c) => c.expect.method));
    expect([...methods].sort()).toEqual(["fixed", "snap"]);
    expect(cases.select.some((c) => c.expect.window.short_exception)).toBe(true);
    expect(cases.select.some((c) => c.expect.window.min_relaxed)).toBe(true);
    const file = {
      family: "selection",
      version: SELECTOR_VERSION,
      sentencizer: SENTENCIZER_VERSION,
      reference: ["server/src/core/snip/sentencize.ts", "server/src/core/snip/select.ts"],
      prefs: DEFAULT_SELECT_PREFS,
      transcripts: Object.fromEntries(Object.entries(transcripts).map(([k, t]) => [k, toApiTranscript(t)])),
      ...cases,
    };
    expect(golden(`selection/${SELECTOR_VERSION}.json`, file)).toEqual(JSON.parse(JSON.stringify(file)));
  });
});
