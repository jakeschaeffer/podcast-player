import type { Static, TSchema } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { buildTranscript, conversation } from "../../../test/helpers/transcript.js";
import { parseAgainstSchema, type GenerateRequest, type GenerateResult, type TextModel } from "../../adapters/textModel.js";
import { sentencize } from "../snip/sentencize.js";
import { DEFAULT_EPISODE_LIMITS, resolveEpisodeSummary, summarizeEpisode, type EpisodeSummaryInput } from "./episode.js";
import { candidateNames, isTitleCase, unsupportedNames } from "./names.js";
import { buildSnipSummaryPrompt, countSentences, fallbackTitle, quoteKey, summarizeSnip, validateSnipBullets, validateSnipSummary, type SnipSummaryInput } from "./snip.js";

/** A TextModel that replays scripted answers (raw strings or objects) and records prompts. */
class FakeModel implements TextModel {
  readonly name = "fake";
  readonly prompts: string[] = [];
  constructor(private readonly answers: unknown[]) {}
  async generate<S extends TSchema>(req: GenerateRequest<S>): Promise<GenerateResult<Static<S>>> {
    this.prompts.push(req.user);
    const next = this.answers.shift();
    if (next instanceof Error) throw next;
    return { data: parseAgainstSchema(req.schema, next), model: "fake-1", elapsed_ms: 1 };
  }
}

describe("names", () => {
  it("finds capitalized non-sentence-initial tokens", () => {
    expect(candidateNames("The guest says Priya left Acme. Later she joined Beacon Labs.")).toEqual(["Priya", "Acme", "Beacon", "Labs"]);
  });
  it("flags names absent from the allowed sources", () => {
    expect(unsupportedNames("Priya argues that Acme's plan failed.", ["priya talked about the plan", "Episode 4: Acme"])).toEqual([]);
    expect(unsupportedNames("Priya argues that Marcus was wrong.", ["priya talked about the plan"])).toEqual(["Marcus"]);
  });
  it("treats a sentence's first word as a name when a verb of saying follows it", () => {
    expect(candidateNames("Marcus explains the fee. Asked about pricing, the guest agrees. One host says no.")).toEqual(["Marcus"]);
  });
  it("ends a sentence at a closing straight quote", () => {
    expect(candidateNames("He calls it 'the bridge of us.' Such a pair helps. She said \"done.\" Later Priya left.")).toEqual(["Priya"]);
  });
  it("reads each text on its own, so a summary's first word starts a sentence", () => {
    expect(unsupportedNames(["A flat fee nobody upgraded from", "Asked about pricing, the guest says nobody upgraded."], ["the guest says nobody upgraded"])).toEqual([]);
    expect(unsupportedNames("A flat fee nobody upgraded from Asked about pricing", ["nobody upgraded"])).toEqual(["Asked"]);
  });
  it("recognizes Title Case titles", () => {
    expect(isTitleCase("Low Sexual Desire Strongly Tied to Women's Quality of Life")).toBe(true);
    expect(isTitleCase("Raoul Pal Sees the NFT Slump as the Last Phase of Pessimism")).toBe(true);
    expect(isTitleCase("Celestia rehearsed its launch with a testnet every week")).toBe(false);
    expect(isTitleCase("Chris Best won't say if Substack Notes would allow racism")).toBe(false);
    expect(isTitleCase("Fees Matter")).toBe(false); // too few words to tell
  });
});

describe("snip summary", () => {
  const t = buildTranscript([
    { speaker: "host", text: "So what did you actually try first?" },
    { speaker: "guest", text: "The first thing we tried was a flat monthly fee for everyone. It felt simple and fair. We ran it for three months and almost nobody upgraded." },
  ]);
  const excerpt = sentencize(t);
  const input: SnipSummaryInput = { excerpt, context: { show_title: "Pricing Talk", episode_title: "Flat fees with Dana Ortiz" } };

  it("builds a prompt that delimits content and labels sentences by id", () => {
    const p = buildSnipSummaryPrompt({ ...input, context: { ...input.context, preceding: excerpt.slice(0, 1), speaker_names: { S2: "Dana Ortiz" } } });
    expect(p.user).toContain("<excerpt>");
    expect(p.user).toContain("<preceding_context_not_citable>");
    expect(p.user).toMatch(/\[1\] Dana Ortiz: The first thing/);
    expect(p.system).toMatch(/third person/);
  });

  it("validates lengths, citations, framing, and invented names", () => {
    const good = { title: "A flat fee that nobody upgraded from", summary: "The guest says the first pricing attempt was a flat monthly fee. After three months almost nobody upgraded.", claims: [{ text: "a", sentence_ids: [1] }, { text: "b", sentence_ids: [3] }] };
    expect(validateSnipSummary(good, input)).toEqual([]);
    expect(validateSnipSummary({ ...good, title: "x".repeat(61) }, input)).toEqual([expect.stringMatching(/title is 61/)]);
    expect(validateSnipSummary({ ...good, claims: [{ text: "a", sentence_ids: [42] }] }, input)).toEqual(expect.arrayContaining([expect.stringMatching(/sentence ids not in the excerpt: 42/)]));
    expect(validateSnipSummary({ ...good, summary: "In this clip the guest explains fees." }, input)).toEqual(expect.arrayContaining([expect.stringMatching(/this clip/)]));
    expect(validateSnipSummary({ ...good, summary: "The guest tells Marcus the fee failed." }, input)).toEqual(expect.arrayContaining([expect.stringMatching(/names not found.*Marcus/)]));
    expect(validateSnipSummary({ ...good, summary: "Dana Ortiz says the fee failed." }, input)).toEqual([]); // name from the episode title
    expect(validateSnipSummary({ ...good, summary: "One. Two. Three. Four." }, input)).toEqual(expect.arrayContaining([expect.stringMatching(/4 sentences/)]));
  });

  it("checks the title and summary apart, and skips the capitals of a Title Case title", () => {
    const good = { title: "A flat fee that nobody upgraded from", summary: "Asked about pricing, the guest says almost nobody upgraded.", claims: [{ text: "a", sentence_ids: [1] }] };
    expect(validateSnipSummary(good, input)).toEqual([]);
    expect(validateSnipSummary({ ...good, title: "Flat Fees Fail When Customers Never Upgrade" }, input)).toEqual([]);
    expect(validateSnipSummary({ ...good, title: "Why Marcus dropped the flat fee" }, input)).toEqual([expect.stringMatching(/names not found.*Marcus/)]);
  });

  it("validates bullets: count, length, citations, framing, names, and a word-for-word quote", () => {
    const good = {
      title: "A flat fee that nobody upgraded from",
      bullets: [{ text: "The first attempt is a flat monthly fee for everyone.", sentence_ids: [1] }, { text: "Almost nobody upgrades in three months.", sentence_ids: [3] }],
      quote: "We ran it for three months and almost nobody upgraded.",
    };
    expect(validateSnipBullets(good, input)).toEqual([]);
    expect(validateSnipBullets({ ...good, quote: "" }, input)).toEqual([]);
    expect(validateSnipBullets({ ...good, quote: "We ran it for, uh, three months and almost nobody upgraded" }, input)).toEqual([]);
    expect(validateSnipBullets({ ...good, quote: "We ran it for six months and everybody upgraded." }, input)).toEqual([expect.stringMatching(/not word for word/)]);
    expect(validateSnipBullets({ ...good, quote: "Simple." }, input)).toEqual(expect.arrayContaining([expect.stringMatching(/quote is 7 characters/)]));
    expect(validateSnipBullets({ ...good, bullets: Array.from({ length: 6 }, () => good.bullets[0]!) }, input)).toEqual([expect.stringMatching(/6 bullets; max 5/)]);
    expect(validateSnipBullets({ ...good, bullets: [{ text: "x".repeat(141), sentence_ids: [1] }] }, input)).toEqual([expect.stringMatching(/bullet 1 is 141 characters/)]);
    expect(validateSnipBullets({ ...good, bullets: [{ text: "a", sentence_ids: [42] }] }, input)).toEqual([expect.stringMatching(/bullet 1 cites sentence ids not in the excerpt: 42/)]);
    expect(validateSnipBullets({ ...good, bullets: [{ text: "In this clip the fee fails.", sentence_ids: [1] }] }, input)).toEqual([expect.stringMatching(/this clip/)]);
    expect(validateSnipBullets({ ...good, bullets: [{ text: "The fee fails, Marcus says.", sentence_ids: [1] }] }, input)).toEqual([expect.stringMatching(/names not found.*Marcus/)]);
    expect(validateSnipBullets({ ...good, bullets: [{ text: "- A dash the model added.", sentence_ids: [1] }] }, input)).toEqual([]);
    expect(quoteKey("It’s “simple”,  uh, fair")).toBe(quoteKey("it's simple fair"));
  });

  it("returns bullets one per line and the quote, or null for an empty one", async () => {
    const model = new FakeModel([{ title: "Fees", bullets: [{ text: "• A flat fee comes first.", sentence_ids: [1] }, { text: "Nobody upgrades.", sentence_ids: [3] }], quote: " " }]);
    const res = await summarizeSnip(input, model);
    expect(res.ok && { summary: res.summary, quote: res.quote }).toEqual({ summary: "A flat fee comes first.\nNobody upgrades.", quote: null });
  });

  it("regenerates once with the problems and then succeeds", async () => {
    const model = new FakeModel([
      { title: "Fees", bullets: [{ text: "Marcus explains the fee.", sentence_ids: [1] }], quote: "" },
      { title: "Fees", bullets: [{ text: "A flat fee comes first.", sentence_ids: [1] }], quote: "" },
    ]);
    const res = await summarizeSnip(input, model);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.attempts).toBe(2);
      expect(res.problems_on_first_try[0]).toMatch(/Marcus/);
    }
    expect(model.prompts[1]).toMatch(/previous answer was rejected/);
  });

  it("returns a fallback title when both attempts fail, and does not reprompt on transport errors", async () => {
    const twiceBad = new FakeModel(["not json at all", { title: "x", bullets: [{ text: "Zed said so.", sentence_ids: [9] }], quote: "" }]);
    const res = await summarizeSnip(input, twiceBad);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.attempts).toBe(2);
      expect(res.fallback_title).toBe("So what did you actually try first? The…");
    }
    const transport = new FakeModel([new Error("ECONNRESET")]);
    const r2 = await summarizeSnip(input, transport);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.attempts).toBe(1);
  });

  it("counts sentences and builds fallback titles sensibly", () => {
    expect(countSentences("One thing. Another thing? Yes!")).toBe(3);
    expect(countSentences("Costs rose 3.5 percent last year.")).toBe(1);
    expect(fallbackTitle(excerpt.slice(1, 2))).toBe("The first thing we tried was a flat…");
  });
});

describe("episode summary", () => {
  const t = conversation(3, 30);
  const duration_ms = t.segments.at(-1)!.end_ms + 1000;
  const sentences = sentencize(t);
  const input: EpisodeSummaryInput = { transcript: t, duration_ms, metadata: { show_title: "Show", episode_title: "Ep", description_text: "", language: "eng" } };
  const limits = DEFAULT_EPISODE_LIMITS;
  const at = (ms: number) => sentences.find((s) => s.start_ms >= ms)!.id;

  it("computes times from sentence ids, repairs the first start, merges short chapters, and caps the count", () => {
    const out = {
      preview: "An episode.",
      takeaways: [{ text: "Latency dropped.", sentence_id: at(60_000) }, { text: "bad", sentence_id: 99_999 }],
      chapters: [
        { start_sentence_id: at(5_000), title: "Opening", description: "", kind: "content" as const },
        { start_sentence_id: at(600_000), title: "Tiny", description: "d", kind: "content" as const }, // 30 s long: merged into "Opening"
        { start_sentence_id: at(630_000), title: "Second topic", description: "", kind: "content" as const },
        { start_sentence_id: at(1_200_000), title: "A very long chapter title that goes on and on past fifty characters", description: "x".repeat(200), kind: "content" as const },
      ],
    };
    const r = resolveEpisodeSummary(out, sentences, input, limits);
    expect(r.problems).toEqual([]);
    expect(r.chapters.map((c) => c.title)).toEqual(["Opening", "Second topic", "A very long chapter title that goes on and on pas…"]);
    expect(r.chapters[0]!.start_ms).toBe(0);
    expect(r.chapters[0]!.start_word).toBe(0);
    for (let i = 1; i < r.chapters.length; i++) {
      expect(r.chapters[i]!.start_ms).toBe(r.chapters[i - 1]!.end_ms);
      expect(r.chapters[i]!.start_word).toBe(r.chapters[i - 1]!.end_word);
    }
    expect(r.chapters.at(-1)!.end_ms).toBe(duration_ms);
    expect(r.chapters.at(-1)!.end_word).toBe(t.word_count);
    expect(r.chapters.at(-1)!.description.length).toBe(limits.description_max);
    expect(r.takeaways).toEqual([{ text: "Latency dropped.", word: sentences[at(60_000)]!.start_word }]);
    expect(r.repairs.some((x) => /first chapter moved/.test(x))).toBe(true);
    expect(r.repairs.some((x) => /merged short chapter "Tiny"/.test(x))).toBe(true);
  });

  it("enforces the chapter cap by merging the shortest content chapters", () => {
    const starts = Array.from({ length: 20 }, (_, i) => at(i * 85_000));
    const out = { preview: "p", takeaways: [{ text: "t", sentence_id: 0 }], chapters: starts.map((s, i) => ({ start_sentence_id: s, title: `C${i}`, description: "", kind: "content" as const })) };
    const r = resolveEpisodeSummary(out, sentences, input, limits);
    expect(r.problems).toEqual([]);
    expect(r.chapters.length).toBeLessThanOrEqual(limits.max_chapters(duration_ms));
  });

  it("reports unknown chapter ids and invented names as problems", () => {
    const out = { preview: "The host talks to Marcus.", takeaways: [{ text: "t", sentence_id: 0 }], chapters: [{ start_sentence_id: 0, title: "A", description: "", kind: "content" as const }, { start_sentence_id: 424242, title: "B", description: "", kind: "content" as const }] };
    const r = resolveEpisodeSummary(out, sentences, input, limits);
    expect(r.problems).toEqual(expect.arrayContaining([expect.stringMatching(/unknown sentence id 424242/), expect.stringMatching(/Marcus/)]));
  });

  it("reads each piece apart and skips the capitals of Title Case chapter titles", () => {
    const out = {
      preview: "The team talks about releases.",
      takeaways: [{ text: "Releases got faster", sentence_id: at(30_000) }, { text: "Nobody expected it.", sentence_id: at(60_000) }],
      chapters: [{ start_sentence_id: 0, title: "Why Releases Finally Got Faster", description: "Asked about speed, the team explains.", kind: "content" as const }],
    };
    expect(resolveEpisodeSummary(out, sentences, input, limits).problems).toEqual([]);
    const named = { ...out, chapters: [{ ...out.chapters[0]!, title: "Talking pricing with Marcus" }] };
    expect(resolveEpisodeSummary(named, sentences, input, limits).problems).toEqual([expect.stringMatching(/Marcus/)]);
  });

  it("runs a single pass for a normal episode and retries once on problems", async () => {
    const good = { preview: "The team talks about shipping.", takeaways: [{ text: "Latency dropped by half.", sentence_id: at(30_000) }], chapters: [{ start_sentence_id: 0, title: "Start", description: "", kind: "intro" as const }, { start_sentence_id: at(400_000), title: "Shipping", description: "", kind: "content" as const }] };
    const model = new FakeModel([{ ...good, preview: "The host talks to Zelda about shipping." }, good]);
    const res = await summarizeEpisode(input, model);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.mode).toBe("single");
      expect(res.attempts).toBe(2);
      expect(res.chapters).toHaveLength(2);
    }
    expect(model.prompts[0]).toContain("<transcript>");
    expect(model.prompts[0]).toMatch(/\[0\] 0:0\d (A|B|S1|S2): /);
    expect(model.prompts[1]).toMatch(/Zelda/);
  });

  it("uses windows and a reduce call for very long transcripts", async () => {
    const long = conversation(5, 150);
    const longDuration = long.segments.at(-1)!.end_ms + 1000;
    const longSentences = sentencize(long);
    const idAt = (ms: number) => longSentences.find((s) => s.start_ms >= ms)!.id;
    const windowAnswer = (fromMs: number) => ({ notes: [{ text: "A point.", sentence_id: idAt(fromMs + 60_000) }], chapters: [{ start_sentence_id: idAt(fromMs + 1000), title: `Topic at ${Math.round(fromMs / 60_000)}m`, description: "", kind: "content" as const }] });
    const windows = Math.ceil(longDuration / limits.window_ms);
    const answers: unknown[] = [];
    for (let i = 0; i < windows; i++) answers.push(windowAnswer(i * limits.window_ms));
    answers.push({ preview: "Long talk.", takeaways: [{ text: "A point.", sentence_id: idAt(60_000) }], chapters: Array.from({ length: windows }, (_, i) => ({ proposal_ids: [i], title: `Chapter ${i + 1}`, description: "", kind: "content" as const })) });
    const model = new FakeModel(answers);
    const res = await summarizeEpisode({ ...input, transcript: long, duration_ms: longDuration, limits: { single_pass_max_chars: 50_000 } }, model);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.mode).toBe("windows");
      expect(res.chapters.map((c) => c.title)).toEqual(Array.from({ length: windows }, (_, i) => `Chapter ${i + 1}`));
      expect(res.chapters[0]!.start_ms).toBe(0);
      expect(res.chapters.at(-1)!.end_ms).toBe(longDuration);
    }
    expect(model.prompts).toHaveLength(windows + 1);
    expect(model.prompts[1]).toMatch(/\(context\)/);
  });
});
