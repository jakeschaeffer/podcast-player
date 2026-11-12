import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Static, TSchema } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { parseAgainstSchema, type GenerateRequest, type GenerateResult, type TextModel } from "../src/adapters/textModel.js";
import { DEFAULT_SELECT_PREFS, WIDE_REACH_MS } from "../src/core/snip/select.js";
import { sentencize } from "../src/core/snip/sentencize.js";
import { DEFAULT_EPISODE_LIMITS, summarizeEpisode, type EpisodeSummaryInput } from "../src/core/summary/episode.js";
import { PROMPT_NAMES, readRegistry, type PromptName } from "../src/core/summary/prompts.js";
import { summarizeSnip, type SnipSummaryInput } from "../src/core/summary/snip.js";
import { makeSpanPicker } from "../src/services/spanPicker.js";
import { identifySpeakers, speakerSamples, type SpeakersInput } from "../src/core/speakers/identify.js";
import type { TitleCase } from "../src/evals/snip-titles/cases.js";
import { judge } from "../src/evals/snip-titles/run.js";
import { buildTranscript, conversation } from "./helpers/transcript.js";


/**
 * Prompt versions (server/prompts/README.md). A version is one instruction file, prompts/<name>/vN.md, written once:
 * registry.json records its hash when it is created, and the first test below fails if the file changes afterwards.
 *
 * Everything else the model sees is built in code: the message around the content, the retry wording, the output
 * schema, and the long-episode window and merge steps. ASSEMBLY records a fingerprint of those parts for each prompt,
 * with the instructions left out, from fixed sample inputs. A code change that alters what the model sees fails here;
 * update the fingerprint on purpose, and create and activate a new version so outputs before and after stay apart.
 */
const ASSEMBLY: Record<PromptName, string> = {
  "snip-summary": "sha256:5738e79a94ee1283",
  "episode-summary": "sha256:fa969bb8c1b7866b",
  "span-picker": "sha256:afbf22ca68e4295a",
  speakers: "sha256:f5327a008c04674c",
  "title-judge": "sha256:31ffd800597cdba1",
};

type Call = { system: string; user: string; schema: unknown };

/** Stands in for the model: records each request and answers from a script. Never calls anything real. */
class RecordingModel implements TextModel {
  readonly name = "recording";
  readonly calls: Call[] = [];
  constructor(private readonly answers: unknown[]) {}
  async generate<S extends TSchema>(req: GenerateRequest<S>): Promise<GenerateResult<Static<S>>> {
    this.calls.push({ system: req.system, user: req.user, schema: req.schema });
    return { data: parseAgainstSchema(req.schema, this.answers.shift()), model: "recording", elapsed_ms: 0 };
  }
}

/** What the model receives, minus the instruction text, which the registry hashes on its own. */
function fingerprint(calls: Call[]): string {
  const assembly = calls.map((c) => ({ ...c, system: "<instructions>" }));
  return `sha256:${createHash("sha256").update(JSON.stringify(assembly)).digest("hex").slice(0, 16)}`;
}

/** Snip title and summary: a first answer that fails validation, so the retry wording is covered too. */
async function snipSummaryCalls(): Promise<Call[]> {
  const t = buildTranscript([
    { speaker: "host", text: "So what did you actually try first?" },
    { speaker: "guest", text: "The first thing we tried was a flat monthly fee for everyone. It felt simple and fair. We ran it for three months and almost nobody upgraded." },
  ]);
  const sentences = sentencize(t);
  const input: SnipSummaryInput = {
    excerpt: sentences.slice(1),
    context: { show_title: "Pricing Talk", episode_title: "Flat fees with Dana Ortiz", speaker_names: { S2: "Dana Ortiz" }, preceding: sentences.slice(0, 1) },
  };
  const model = new RecordingModel([
    { title: "Fees", bullets: [{ text: "Marcus explains the fee.", sentence_ids: [1] }], quote: "" },
    { title: "Fees", bullets: [{ text: "A flat monthly fee for everyone comes first.", sentence_ids: [1] }], quote: "almost nobody upgraded" },
  ]);
  const res = await summarizeSnip(input, model);
  expect(res.ok && res.attempts).toBe(2);
  return model.calls;
}

/** Episode preview, takeaways, and chapters: a single pass with one retry, then the window-and-merge path. */
async function episodeSummaryCalls(): Promise<Call[]> {
  const metadata = { show_title: "Show", episode_title: "Ep", description_text: "Notes from the publisher.", language: "eng" };
  const t = conversation(3, 30);
  const sentences = sentencize(t);
  const at = (ms: number) => sentences.find((s) => s.start_ms >= ms)!.id;
  const good = { preview: "The team talks about shipping.", takeaways: [{ text: "Latency dropped by half.", sentence_id: at(30_000) }], chapters: [{ start_sentence_id: 0, title: "Start", description: "", kind: "intro" as const }, { start_sentence_id: at(400_000), title: "Shipping", description: "", kind: "content" as const }] };
  const single = new RecordingModel([{ ...good, preview: "The host talks to Zelda about shipping." }, good]);
  const input: EpisodeSummaryInput = { transcript: t, duration_ms: t.segments.at(-1)!.end_ms + 1000, metadata };
  const first = await summarizeEpisode(input, single);
  expect(first.ok && first.mode === "single" && first.attempts).toBe(2);

  const long = conversation(5, 150);
  const longDuration = long.segments.at(-1)!.end_ms + 1000;
  const longSentences = sentencize(long);
  const idAt = (ms: number) => longSentences.find((s) => s.start_ms >= ms)!.id;
  const windows = Math.ceil(longDuration / DEFAULT_EPISODE_LIMITS.window_ms);
  const answers: unknown[] = [];
  for (let i = 0; i < windows; i++) {
    const from = i * DEFAULT_EPISODE_LIMITS.window_ms;
    answers.push({ notes: [{ text: "A point.", sentence_id: idAt(from + 60_000) }], chapters: [{ start_sentence_id: idAt(from + 1000), title: `Topic ${i + 1}`, description: "", kind: "content" as const }] });
  }
  answers.push({ preview: "Long talk.", takeaways: [{ text: "A point.", sentence_id: idAt(60_000) }], chapters: Array.from({ length: windows }, (_, i) => ({ proposal_ids: [i], title: `Chapter ${i + 1}`, description: "", kind: "content" as const })) });
  const windowed = new RecordingModel(answers);
  const second = await summarizeEpisode({ transcript: long, duration_ms: longDuration, metadata, limits: { single_pass_max_chars: 50_000 } }, windowed);
  expect(second.ok && second.mode).toBe("windows");
  return [...single.calls, ...windowed.calls];
}

/** Snip start choice (only used with SELECTION_MODEL=on): the normal rule and the short-window exception. */
async function spanPickerCalls(): Promise<Call[]> {
  const t = buildTranscript([
    { speaker: "host", text: "Can I ask about pricing? What did you try first?" },
    { speaker: "guest", text: "We started with a flat monthly fee. It felt simple and fair. Almost nobody upgraded. So we moved to usage tiers." },
  ]);
  const sentences = sentencize(t).map((s) => ({ ...s, eligible: true }));
  const end_id = sentences.length - 1;
  const model = new RecordingModel([{ start_id: 2, reason: "the answer begins here" }, { start_id: 1, reason: "the question" }]);
  const pick = makeSpanPicker(model);
  for (const short_exception of [false, true]) {
    await pick({ sentences, end_id, snap_start_id: 2, candidate_start_ids: [1, 2, 3], anchor_ms: sentences[end_id]!.end_ms, prefs: DEFAULT_SELECT_PREFS, short_exception });
  }
  return model.calls;
}

/**
 * Snip start with reach (every version after v1): the picker is offered a range, not a handful, and the message is
 * built for one. v1's message above is untouched, which is why its fingerprint did not move when this was added.
 */
const SPAN_PICKER_WITH_REACH = "sha256:7d7edeca4b5904a0";
async function spanPickerReachCalls(): Promise<{ calls: Call[]; picker: ReturnType<typeof makeSpanPicker> }> {
  const t = buildTranscript([
    { speaker: "host", text: "Can I ask about pricing? What did you try first?" },
    { speaker: "guest", text: "We started with a flat monthly fee. It felt simple and fair. Almost nobody upgraded. So we moved to usage tiers." },
  ]);
  const sentences = sentencize(t).map((s) => ({ ...s, eligible: true }));
  const end_id = sentences.length - 1;
  const model = new RecordingModel([{ start_id: 1, reason: "the question" }, { start_id: 1, reason: "the question" }, { start_id: 1, reason: "the question" }]);
  const picker = makeSpanPicker(model, { version: "v2" });
  for (const short_exception of [false, true]) {
    await picker({ sentences, end_id, snap_start_id: 2, candidate_start_ids: [1, 2, 3], anchor_ms: sentences[end_id]!.end_ms, prefs: DEFAULT_SELECT_PREFS, short_exception });
  }
  // Candidates that are not one unbroken run are listed one by one.
  await picker({ sentences, end_id, snap_start_id: 3, candidate_start_ids: [1, 3], anchor_ms: sentences[end_id]!.end_ms, prefs: DEFAULT_SELECT_PREFS, short_exception: false });
  return { calls: model.calls, picker };
}

/** Speakers: an interview where the first answer invents a name, so the retry wording is covered too. */
async function speakersCalls(): Promise<Call[]> {
  const t = buildTranscript([
    { speaker: "host", text: "Welcome back. Today I'm talking with Dana Ortiz about pricing. What did you try first?" },
    { speaker: "guest", text: "The first thing we tried was a flat monthly fee for everyone. Almost nobody upgraded." },
    { speaker: "clip", text: "From another show: pricing is hard.", pause_ms: 800 },
  ]);
  const input: SpeakersInput = { show_title: "Pricing Talk", author: "Sam Lee", episode_title: "An Interview with Dana Ortiz", description_text: "Sam talks with Dana Ortiz about flat fees.", labels: speakerSamples(t) };
  const model = new RecordingModel([
    { speakers: [{ label: "S1", role: "host", name: "Sam Lee" }, { label: "S2", role: "guest", name: "Marcus" }, { label: "S3", role: "other", name: "" }] },
    { speakers: [{ label: "S1", role: "host", name: "Sam Lee" }, { label: "S2", role: "guest", name: "Dana Ortiz" }, { label: "S3", role: "other", name: "" }] },
  ]);
  const res = await identifySpeakers(input, model);
  expect(res.ok && res.attempts).toBe(2);
  return model.calls;
}

/** The title judge (evals only): one comparison. */
async function titleJudgeCalls(): Promise<Call[]> {
  const model = new RecordingModel([{ score: 4, missing: "the three months" }]);
  await judge(model, { id: "c1", source: "app", show: "Pricing Talk", episode: "Flat fees", excerpt: [{ speaker: "S2", text: "Almost nobody upgraded." }], reference_title: "Nobody upgraded in three months" } as TitleCase, "Nobody upgraded");
  return model.calls;
}

const SCENARIOS: Record<PromptName, () => Promise<Call[]>> = {
  "snip-summary": snipSummaryCalls,
  "episode-summary": episodeSummaryCalls,
  "span-picker": spanPickerCalls,
  speakers: speakersCalls,
  "title-judge": titleJudgeCalls,
};

const dir = join(dirname(fileURLToPath(import.meta.url)), "../prompts");
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

describe("prompt versions", () => {
  it("every version file is listed in registry.json and unchanged since it was created", () => {
    const registry = readRegistry();
    for (const name of PROMPT_NAMES) {
      const files = readdirSync(join(dir, name)).filter((f) => /^v\d+\.md$/.test(f)).map((f) => f.slice(0, -3)).sort();
      expect(Object.keys(registry[name].versions).sort(), `${name}: registry.json should list exactly the files in prompts/${name}`).toEqual(files);
      for (const v of files) {
        expect(sha256(join(dir, name, `${v}.md`)), `prompts/${name}/${v}.md changed after it was created. Leave it as it was and create a new version instead.`).toBe(registry[name].versions[v]!.sha256);
      }
      expect(files, `${name}: the active version ${registry[name].active} has no file`).toContain(registry[name].active);
    }
  });

  it("span-picker: v1 keeps its handful of candidates; later versions ask for reach and are shown a range", async () => {
    expect(makeSpanPicker(new RecordingModel([]), { version: "v1" }).reach_ms).toBeUndefined();
    const { calls, picker } = await spanPickerReachCalls();
    expect([picker.prompt_version, picker.reach_ms]).toEqual(["v2", WIDE_REACH_MS]);
    const [normal, short, listed] = calls.map((c) => c.user);
    expect(normal).toContain("The snip may start at any sentence from 1 to 3. Default: 2. End: 5.");
    expect(normal).toContain("Any start in the range gives a snip between 30 and 240 seconds long.");
    expect(normal).toMatch(/\[0\] \(not a start\) 15s S1: Can I ask about pricing\?/);
    expect(normal).toMatch(/\[2\] \(DEFAULT\) 9s S2: We started with a flat monthly fee\./);
    expect(normal).toMatch(/\[4\] \(not a start\) 4s S2: Almost nobody upgraded\./);
    expect(normal).toMatch(/\[5\] \(END\) 2s S2: So we moved to usage tiers\./);
    expect(short).toContain("shorter than the usual minimum; any start in the range is acceptable");
    expect(listed).toContain("The snip may start at one of: 1, 3.");
    const actual = fingerprint(calls);
    expect(actual, `What the code sends around the span-picker instructions of a version with reach changed. If that is intended, record ${actual} in SPAN_PICKER_WITH_REACH, then create a new version of span-picker so picks from before and after stay apart.`).toBe(SPAN_PICKER_WITH_REACH);
  });

  for (const name of PROMPT_NAMES) {
    it(`${name}: the code-built part of the prompt matches its recorded fingerprint`, async () => {
      const actual = fingerprint(await SCENARIOS[name]());
      const hint = ASSEMBLY[name]
        ? `What the code sends around the ${name} instructions changed. If that is intended, record ${actual} in ASSEMBLY, then create and activate a new version of ${name} so outputs from before and after stay apart.`
        : `Record "${actual}" for "${name}" in ASSEMBLY.`;
      expect(actual, hint).toBe(ASSEMBLY[name]);
    });
  }
});

describe("prompts folder", () => {
  const readme = readFileSync(join(dir, "README.md"), "utf8");

  it("has a folder for every prompt and nothing else", () => {
    const folders = readdirSync(dir).filter((f) => statSync(join(dir, f)).isDirectory()).sort();
    expect(folders).toEqual([...PROMPT_NAMES].sort());
  });

  it("README has no broken links", () => {
    const hrefs = [...readme.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!).filter((href) => !/^(https?:|#|mailto:)/.test(href));
    expect(hrefs.length).toBeGreaterThan(10);
    expect(hrefs.filter((href) => !existsSync(resolve(dir, href.split("#")[0]!)))).toEqual([]);
  });
});
