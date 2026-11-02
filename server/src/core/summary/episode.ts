import { Type, type Static } from "@sinclair/typebox";
import { delimited, SchemaMismatchError, type TextModel } from "../../adapters/textModel.js";
import { sentencize, type Sentence } from "../snip/sentencize.js";
import type { EventTuple, NormalizedTranscript } from "../transcript/types.js";
import { isTitleCase, unsupportedNames } from "./names.js";
import { resolvePrompt } from "./prompts.js";

const ChapterKind = Type.Union([Type.Literal("content"), Type.Literal("intro"), Type.Literal("ad"), Type.Literal("outro")]);

export const EpisodeSummarySchema = Type.Object(
  {
    preview: Type.String({ minLength: 1, maxLength: 1500 }),
    takeaways: Type.Array(Type.Object({ text: Type.String({ minLength: 1 }), sentence_id: Type.Integer() }), { minItems: 1, maxItems: 10 }),
    chapters: Type.Array(
      Type.Object({ start_sentence_id: Type.Integer(), title: Type.String({ minLength: 1, maxLength: 300 }), description: Type.String({ maxLength: 800 }), kind: ChapterKind }),
      { minItems: 1, maxItems: 80 },
    ),
  },
  { additionalProperties: false },
);
export type EpisodeSummaryOutput = Static<typeof EpisodeSummarySchema>;

const WindowSchema = Type.Object(
  {
    notes: Type.Array(Type.Object({ text: Type.String({ minLength: 1 }), sentence_id: Type.Integer() }), { minItems: 1, maxItems: 10 }),
    chapters: Type.Array(
      Type.Object({ start_sentence_id: Type.Integer(), title: Type.String({ minLength: 1, maxLength: 300 }), description: Type.String({ maxLength: 800 }), kind: ChapterKind }),
      { minItems: 1, maxItems: 30 },
    ),
  },
  { additionalProperties: false },
);

const ReduceSchema = Type.Object(
  {
    preview: Type.String({ minLength: 1, maxLength: 1500 }),
    takeaways: Type.Array(Type.Object({ text: Type.String({ minLength: 1 }), sentence_id: Type.Integer() }), { minItems: 1, maxItems: 10 }),
    chapters: Type.Array(
      Type.Object({ proposal_ids: Type.Array(Type.Integer(), { minItems: 1 }), title: Type.String({ minLength: 1, maxLength: 300 }), description: Type.String({ maxLength: 800 }), kind: ChapterKind }),
      { minItems: 1, maxItems: 80 },
    ),
  },
  { additionalProperties: false },
);

export type EpisodeLimits = {
  min_chapter_ms: number;
  max_chapters: (duration_ms: number) => number;
  title_max: number;
  description_max: number;
  /** Above this many characters of transcript, use windows and a reduce call. About 80k tokens. */
  single_pass_max_chars: number;
  window_ms: number;
  window_context_ms: number;
};

export const DEFAULT_EPISODE_LIMITS: EpisodeLimits = {
  min_chapter_ms: 90_000,
  max_chapters: (duration_ms) => Math.max(1, Math.ceil(duration_ms / 240_000)),
  title_max: 50,
  description_max: 160,
  single_pass_max_chars: 320_000,
  window_ms: 40 * 60_000,
  window_context_ms: 2 * 60_000,
};

export type Chapter = { start_ms: number; end_ms: number; start_word: number; end_word: number; title: string; description: string; kind: "content" | "intro" | "ad" | "outro" };
export type Takeaway = { text: string; word: number };

export type EpisodeSummaryInput = {
  transcript: NormalizedTranscript;
  duration_ms: number;
  metadata: { show_title: string; episode_title: string; description_text: string; language: string | null };
  limits?: Partial<EpisodeLimits>;
};

export type EpisodeSummaryResult =
  | { ok: true; preview: string; takeaways: Takeaway[]; chapters: Chapter[]; repairs: string[]; model: string; prompt_version: string; attempts: number; mode: "single" | "windows" }
  | { ok: false; problems: string[]; model: string | null; prompt_version: string; attempts: number; mode: "single" | "windows" };

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

/** One line per sentence, events interleaved by time. The model sees sentences, never words. */
export function renderTranscriptLines(sentences: Sentence[], events: EventTuple[], opts: { contextBefore?: number } = {}): string {
  const lines: string[] = [];
  let ei = 0;
  const sorted = [...events].sort((a, b) => a[0] - b[0]);
  for (const s of sentences) {
    while (ei < sorted.length && sorted[ei]![0] <= s.start_ms) {
      const e = sorted[ei]!;
      lines.push(`[event ${e[2]} ${fmt(e[0])}–${fmt(e[1])}]`);
      ei++;
    }
    const ctx = opts.contextBefore !== undefined && s.id < opts.contextBefore ? " (context)" : "";
    lines.push(`[${s.id}] ${fmt(s.start_ms)} ${s.speaker ?? "-"}:${ctx} ${s.text}`);
  }
  return lines.join("\n");
}

function metadataBlock(m: EpisodeSummaryInput["metadata"], duration_ms: number): string {
  return [`Show: ${m.show_title}`, `Episode: ${m.episode_title}`, `Duration: ${fmt(duration_ms)}`, m.language ? `Language: ${m.language}` : null, m.description_text ? delimited("show_notes_not_a_source_of_quotes", m.description_text.slice(0, 2000)) : null]
    .filter((l): l is string => l !== null)
    .join("\n");
}

/** `system` is the text of a version of prompts/episode-summary. */
export function buildEpisodePrompt(input: EpisodeSummaryInput, sentences: Sentence[], limits: EpisodeLimits, system: string): { system: string; user: string } {
  const maxChapters = limits.max_chapters(input.duration_ms);
  const user = [
    metadataBlock(input.metadata, input.duration_ms),
    `Return at most ${maxChapters} chapters. Chapter start ids must be sentence ids from the transcript.`,
    delimited("transcript", renderTranscriptLines(sentences, input.transcript.events)),
  ].join("\n\n");
  return { system, user };
}

export type Resolved = { chapters: Chapter[]; takeaways: Takeaway[]; repairs: string[]; problems: string[] };

/**
 * Turn model output into validated chapters and takeaways. Repairs what can be repaired deterministically
 * and reports what cannot; a non-empty `problems` means the output must not be saved.
 */
export function resolveEpisodeSummary(out: Pick<EpisodeSummaryOutput, "chapters" | "takeaways" | "preview">, sentences: Sentence[], input: EpisodeSummaryInput, limits: EpisodeLimits): Resolved {
  const repairs: string[] = [];
  const problems: string[] = [];
  const byId = new Map(sentences.map((s) => [s.id, s]));
  const lastSentence = sentences[sentences.length - 1];
  if (!lastSentence) return { chapters: [], takeaways: [], repairs, problems: ["transcript has no sentences"] };

  type Draft = { start: Sentence; title: string; description: string; kind: Chapter["kind"] };
  let drafts: Draft[] = [];
  for (const c of out.chapters) {
    const s = byId.get(c.start_sentence_id);
    if (!s) {
      problems.push(`chapter "${c.title}" starts at unknown sentence id ${c.start_sentence_id}`);
      continue;
    }
    drafts.push({ start: s, title: c.title.trim(), description: c.description.trim(), kind: c.kind });
  }
  if (drafts.length === 0) {
    problems.push("no usable chapters");
    return { chapters: [], takeaways: [], repairs, problems };
  }
  drafts.sort((a, b) => a.start.start_ms - b.start.start_ms || a.start.id - b.start.id);
  drafts = drafts.filter((d, i) => i === 0 || d.start.id !== drafts[i - 1]!.start.id);
  if (drafts[0]!.start.id !== sentences[0]!.id) {
    repairs.push(`first chapter moved from sentence ${drafts[0]!.start.id} to the first sentence`);
    drafts[0] = { ...drafts[0]!, start: sentences[0]! };
  }

  const durationOf = (i: number, list: Draft[]) => (i + 1 < list.length ? list[i + 1]!.start.start_ms : input.duration_ms) - list[i]!.start.start_ms;

  // Merge content chapters shorter than the minimum into their predecessor (or successor for the first).
  for (let i = 0; i < drafts.length; ) {
    const d = drafts[i]!;
    if (d.kind === "content" && durationOf(i, drafts) < limits.min_chapter_ms && drafts.length > 1) {
      if (i === 0) {
        const next = drafts[1]!;
        drafts.splice(0, 2, { ...next, start: d.start });
        repairs.push(`merged short first chapter "${d.title}" into "${next.title}"`);
      } else {
        drafts.splice(i, 1);
        repairs.push(`merged short chapter "${d.title}" into the previous chapter`);
      }
      continue;
    }
    i++;
  }

  // Cap the count by merging the shortest content chapter into its previous neighbour.
  const maxChapters = limits.max_chapters(input.duration_ms);
  while (drafts.length > maxChapters) {
    let shortest = -1;
    let shortestDur = Number.POSITIVE_INFINITY;
    for (let i = 1; i < drafts.length; i++) {
      const dur = durationOf(i, drafts);
      if (drafts[i]!.kind === "content" && dur < shortestDur) { shortest = i; shortestDur = dur; }
    }
    if (shortest < 0) break;
    repairs.push(`merged "${drafts[shortest]!.title}" to respect the chapter cap of ${maxChapters}`);
    drafts.splice(shortest, 1);
  }

  const chapters: Chapter[] = drafts.map((d, i) => {
    const nextStart = i + 1 < drafts.length ? drafts[i + 1]!.start : null;
    let title = d.title;
    let description = d.description;
    if (title.length > limits.title_max) { title = `${title.slice(0, limits.title_max - 1).trimEnd()}…`; repairs.push(`truncated title "${d.title}"`); }
    if (description.length > limits.description_max) { description = `${description.slice(0, limits.description_max - 1).trimEnd()}…`; repairs.push(`truncated description of "${d.title}"`); }
    return {
      start_ms: i === 0 ? 0 : d.start.start_ms,
      end_ms: nextStart ? nextStart.start_ms : input.duration_ms,
      start_word: d.start.start_word,
      end_word: nextStart ? nextStart.start_word : lastSentence.end_word,
      title,
      description,
      kind: d.kind,
    };
  });

  const takeaways: Takeaway[] = [];
  for (const t of out.takeaways) {
    const s = byId.get(t.sentence_id);
    if (!s) { repairs.push(`dropped takeaway citing unknown sentence ${t.sentence_id}`); continue; }
    takeaways.push({ text: t.text.trim(), word: s.start_word });
  }
  if (takeaways.length === 0) problems.push("no takeaway cites a known sentence");

  const allowed = [input.transcript.segments.map((s) => s.text).join(" "), input.metadata.episode_title, input.metadata.show_title, input.metadata.description_text, "host guest"];
  // Each piece is read on its own, so its first word starts a sentence; Title Case chapter titles are left out (see isTitleCase).
  const generated = [out.preview, ...chapters.flatMap((c) => (isTitleCase(c.title) ? [c.description] : [c.title, c.description])), ...takeaways.map((t) => t.text)];
  const names = unsupportedNames(generated, allowed);
  if (names.length > 0) problems.push(`names not found in the transcript or metadata: ${names.join(", ")}`);

  return { chapters, takeaways, repairs, problems };
}

/** Single pass when the transcript fits, otherwise windows plus a reduce call. One retry on validation problems. */
export async function summarizeEpisode(
  input: EpisodeSummaryInput,
  model: TextModel,
  opts: { timeout_ms?: number; onAttempt?: (attempt: number, problems: string[]) => void; version?: string } = {},
): Promise<EpisodeSummaryResult> {
  const limits: EpisodeLimits = { ...DEFAULT_EPISODE_LIMITS, ...input.limits };
  // One version for every call of this summary: the active one unless `version` names another.
  const prompt = resolvePrompt("episode-summary", opts.version);
  const sentences = sentencize(input.transcript);
  const totalChars = sentences.reduce((n, s) => n + s.text.length + 16, 0);
  const mode: "single" | "windows" = totalChars <= limits.single_pass_max_chars ? "single" : "windows";
  const timeout = opts.timeout_ms ? { timeout_ms: opts.timeout_ms } : {};

  let modelName: string | null = null;
  let problems: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const out = mode === "single" ? await singlePass(input, sentences, limits, model, problems, timeout, prompt.text) : await windowed(input, sentences, limits, model, problems, timeout, prompt.text);
      modelName = out.model;
      const resolved = resolveEpisodeSummary(out.data, sentences, input, limits);
      problems = resolved.problems;
      opts.onAttempt?.(attempt, problems);
      if (problems.length === 0) {
        return { ok: true, preview: out.data.preview.trim(), takeaways: resolved.takeaways, chapters: resolved.chapters, repairs: resolved.repairs, model: out.model, prompt_version: prompt.version, attempts: attempt, mode };
      }
    } catch (err) {
      problems = [err instanceof SchemaMismatchError ? err.message : `model call failed: ${err instanceof Error ? err.message : String(err)}`];
      opts.onAttempt?.(attempt, problems);
      if (!(err instanceof SchemaMismatchError)) return { ok: false, problems, model: modelName, prompt_version: prompt.version, attempts: attempt, mode };
    }
  }
  return { ok: false, problems, model: modelName, prompt_version: prompt.version, attempts: 2, mode };
}

function withFeedback(user: string, problems: string[]): string {
  return problems.length === 0 ? user : `${user}\n\nYour previous answer was rejected for these reasons; fix them:\n- ${problems.join("\n- ")}`;
}

async function singlePass(input: EpisodeSummaryInput, sentences: Sentence[], limits: EpisodeLimits, model: TextModel, problems: string[], timeout: { timeout_ms?: number }, instructions: string) {
  const { system, user } = buildEpisodePrompt(input, sentences, limits, instructions);
  return model.generate({ system, user: withFeedback(user, problems), schema: EpisodeSummarySchema, ...timeout });
}

async function windowed(input: EpisodeSummaryInput, sentences: Sentence[], limits: EpisodeLimits, model: TextModel, problems: string[], timeout: { timeout_ms?: number }, system: string): Promise<{ data: EpisodeSummaryOutput; model: string }> {
  const windows: { from: number; to: number }[] = [];
  for (let start = 0; start < input.duration_ms; start += limits.window_ms) windows.push({ from: start, to: Math.min(input.duration_ms, start + limits.window_ms) });

  type Proposal = { id: number; start_sentence_id: number; title: string; description: string; kind: Chapter["kind"]; start_ms: number };
  const proposals: Proposal[] = [];
  const notes: { text: string; sentence_id: number }[] = [];
  let modelName = "";
  for (const [i, w] of windows.entries()) {
    const inWindow = sentences.filter((s) => s.start_ms >= w.from && s.start_ms < w.to);
    if (inWindow.length === 0) continue;
    const context = sentences.filter((s) => s.start_ms >= w.from - limits.window_context_ms && s.start_ms < w.from);
    const shown = [...context, ...inWindow];
    const firstInWindow = inWindow[0]!.id;
    const user = [
      metadataBlock(input.metadata, input.duration_ms),
      `This is window ${i + 1} of ${windows.length}, covering ${fmt(w.from)} to ${fmt(w.to)}. Lines marked (context) precede the window and are only for continuity. Propose chapters that start inside the window (sentence ids ${firstInWindow} and above) and three to eight notes with the key points of this window, each citing a sentence id.`,
      delimited("transcript", renderTranscriptLines(shown, input.transcript.events, { contextBefore: firstInWindow })),
    ].join("\n\n");
    const res = await model.generate({ system, user, schema: WindowSchema, ...timeout });
    modelName = res.model;
    for (const c of res.data.chapters) {
      const s = sentences[c.start_sentence_id];
      if (!s || c.start_sentence_id < firstInWindow) continue;
      proposals.push({ id: proposals.length, start_sentence_id: c.start_sentence_id, title: c.title, description: c.description, kind: c.kind, start_ms: s.start_ms });
    }
    notes.push(...res.data.notes.filter((n) => sentences[n.sentence_id] !== undefined));
  }
  if (proposals.length === 0) throw new SchemaMismatchError("no chapter proposals from any window", null);

  const maxChapters = limits.max_chapters(input.duration_ms);
  const reduceUser = [
    metadataBlock(input.metadata, input.duration_ms),
    `Below are chapter proposals from consecutive windows of the episode, in order, and notes with the key points. Write the preview and takeaways from the notes (cite note sentence ids). Merge adjacent proposals that cover one topic: return at most ${maxChapters} chapters, each as the list of consecutive proposal ids it covers, in order, covering every proposal exactly once, with a final title and description.`,
    delimited("proposals", proposals.map((p) => `[${p.id}] ${fmt(p.start_ms)} (${p.kind}) ${p.title} — ${p.description}`).join("\n")),
    delimited("notes", notes.map((n) => `(sentence ${n.sentence_id}) ${n.text}`).join("\n")),
  ].join("\n\n");
  const reduced = await model.generate({ system, user: withFeedback(reduceUser, problems), schema: ReduceSchema, ...timeout });

  // Accept the grouping only if it is a contiguous partition of the proposals; otherwise keep the proposals as chapters.
  const covered = reduced.data.chapters.flatMap((c) => c.proposal_ids);
  const contiguous = covered.length === proposals.length && covered.every((id, i) => id === i) && reduced.data.chapters.every((c) => c.proposal_ids.every((id, k) => k === 0 || id === c.proposal_ids[k - 1]! + 1));
  const chapters = contiguous
    ? reduced.data.chapters.map((c) => ({ start_sentence_id: proposals[c.proposal_ids[0]!]!.start_sentence_id, title: c.title, description: c.description, kind: c.kind }))
    : proposals.map((p) => ({ start_sentence_id: p.start_sentence_id, title: p.title, description: p.description, kind: p.kind }));
  return { data: { preview: reduced.data.preview, takeaways: reduced.data.takeaways, chapters }, model: reduced.model || modelName };
}
