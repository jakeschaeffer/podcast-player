import { Type, type Static } from "@sinclair/typebox";
import { delimited, SchemaMismatchError, type TextModel } from "../../adapters/textModel.js";
import type { Sentence } from "../snip/sentencize.js";
import { isTitleCase, unsupportedNames } from "./names.js";
import { resolvePrompt } from "./prompts.js";

export const SnipSummarySchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 200 }),
    summary: Type.String({ minLength: 1, maxLength: 1000 }),
    claims: Type.Array(Type.Object({ text: Type.String({ minLength: 1 }), sentence_ids: Type.Array(Type.Integer(), { minItems: 1 }) }), { minItems: 1, maxItems: 6 }),
  },
  { additionalProperties: false },
);
export type SnipSummaryOutput = Static<typeof SnipSummarySchema>;

export type SnipSummaryStyle = { title_max: number; summary_max: number; max_sentences: number };
export const DEFAULT_SNIP_SUMMARY_STYLE: SnipSummaryStyle = { title_max: 60, summary_max: 320, max_sentences: 3 };

/**
 * The answer since snip-summary v3: a title, a few bullets that each cite the excerpt, and the excerpt's most striking
 * line copied word for word (empty when none stands on its own). The prose schema above is kept for the v1 golden
 * file and old evals.
 */
export const SnipBulletsSchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 200 }),
    bullets: Type.Array(Type.Object({ text: Type.String({ minLength: 1, maxLength: 400 }), sentence_ids: Type.Array(Type.Integer(), { minItems: 1 }) }), { minItems: 1, maxItems: 8 }),
    quote: Type.String({ maxLength: 600 }),
  },
  { additionalProperties: false },
);
export type SnipBulletsOutput = Static<typeof SnipBulletsSchema>;

export type SnipBulletsStyle = { title_max: number; bullets_max: number; bullet_max: number; quote_min: number; quote_max: number };
export const DEFAULT_SNIP_BULLETS_STYLE: SnipBulletsStyle = { title_max: 60, bullets_max: 5, bullet_max: 140, quote_min: 20, quote_max: 220 };

export type SnipSummaryInput = {
  /** The exact excerpt, as sentences with ids; the only source of facts. */
  excerpt: Sentence[];
  context: {
    show_title: string;
    episode_title: string;
    /** Speaker label to name, only when known from metadata. */
    speaker_names?: Record<string, string>;
    /** Up to two sentences before the span; context, never citable. */
    preceding?: Sentence[];
  };
  style?: Partial<SnipBulletsStyle>;
};

export type SnipSummaryResult =
  | {
      ok: true; title: string;
      /** The bullets, one per line, as stored in `snip_revision.summary`. */
      summary: string;
      bullets: SnipBulletsOutput["bullets"];
      /** A line copied from the excerpt, or null when the model found none. */
      quote: string | null;
      model: string; prompt_version: string; attempts: number; problems_on_first_try: string[];
    }
  | {
      ok: false; problems: string[]; fallback_title: string; model: string | null; prompt_version: string; attempts: number;
      /** The model could not be reached (not a bad answer): the caller should retry later rather than settle for the fallback. */
      transport_error: boolean;
    };

/** The active version of prompts/snip-summary unless `version` names another (the title eval tries drafts). */
export function buildSnipSummaryPrompt(input: SnipSummaryInput, version?: string): { system: string; user: string; version: string } {
  const prompt = resolvePrompt("snip-summary", version);
  const names = input.context.speaker_names ?? {};
  const label = (s: Sentence) => (s.speaker ? names[s.speaker] ?? s.speaker : "-");
  const lines = [
    `Show: ${input.context.show_title}`,
    `Episode: ${input.context.episode_title}`,
    Object.keys(names).length > 0 ? `Speaker names: ${Object.entries(names).map(([k, v]) => `${k} = ${v}`).join(", ")}` : null,
    input.context.preceding && input.context.preceding.length > 0
      ? delimited("preceding_context_not_citable", input.context.preceding.map((s) => `${label(s)}: ${s.text}`).join("\n"))
      : null,
    delimited("excerpt", input.excerpt.map((s) => `[${s.id}] ${label(s)}: ${s.text}`).join("\n")),
  ].filter((l): l is string => l !== null);
  return { system: prompt.text, user: lines.join("\n\n"), version: prompt.version };
}

/** The prose rules of snip-summary v1 and v2 (snip_summary_validation_v1.json). Empty array means valid. */
export function validateSnipSummary(out: SnipSummaryOutput, input: SnipSummaryInput, style: SnipSummaryStyle = DEFAULT_SNIP_SUMMARY_STYLE): string[] {
  const problems: string[] = [];
  const title = out.title.trim();
  const summary = out.summary.trim();
  if (title.length === 0) problems.push("title is empty");
  if (title.length > style.title_max) problems.push(`title is ${title.length} characters; max ${style.title_max}`);
  if (summary.length === 0) problems.push("summary is empty");
  if (summary.length > style.summary_max) problems.push(`summary is ${summary.length} characters; max ${style.summary_max}`);
  const sentenceCount = countSentences(summary);
  if (sentenceCount > style.max_sentences) problems.push(`summary has ${sentenceCount} sentences; max ${style.max_sentences}`);
  if (/\bin this (clip|excerpt|snip|segment)\b/i.test(summary) || /\bin this (clip|excerpt|snip|segment)\b/i.test(title)) problems.push('summary refers to "this clip"');

  const ids = new Set(input.excerpt.map((s) => s.id));
  for (const [i, claim] of out.claims.entries()) {
    const bad = claim.sentence_ids.filter((id) => !ids.has(id));
    if (bad.length > 0) problems.push(`claim ${i + 1} cites sentence ids not in the excerpt: ${bad.join(", ")}`);
  }
  if (out.claims.length < sentenceCount) problems.push(`summary has ${sentenceCount} sentences but only ${out.claims.length} claims`);

  const allowed = [
    input.excerpt.map((s) => s.text).join(" "),
    input.context.episode_title,
    input.context.show_title,
    Object.values(input.context.speaker_names ?? {}).join(" "),
    "host guest",
  ];
  // Read apart, so the summary's first word starts a sentence. A Title Case title capitalizes ordinary words, so only
  // the summary is checked then; a person the title names nearly always appears there too.
  const names = unsupportedNames(isTitleCase(title) ? [summary] : [title, summary], allowed);
  if (names.length > 0) problems.push(`names not found in the excerpt or metadata: ${names.join(", ")}`);
  return problems;
}

/** A bullet as the model may write it, without a leading dash or bullet character. */
export function cleanBullet(text: string): string {
  return text.trim().replace(/^[-•*–]\s+/u, "");
}

/** Text compared for the word-for-word quote check: letters and digits only, filler words dropped, spaces collapsed. */
export function quoteKey(text: string): string {
  return ` ${text.toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}']+/gu, " ").replace(/\b(uh|um|uhm|erm)\b/g, " ").replace(/\s+/g, " ").trim()} `;
}

/** Everything that must hold before a bulleted summary may be published. Empty array means valid. */
export function validateSnipBullets(out: SnipBulletsOutput, input: SnipSummaryInput, style: SnipBulletsStyle = DEFAULT_SNIP_BULLETS_STYLE): string[] {
  const problems: string[] = [];
  const title = out.title.trim();
  const bullets = out.bullets.map((b) => cleanBullet(b.text));
  if (title.length === 0) problems.push("title is empty");
  if (title.length > style.title_max) problems.push(`title is ${title.length} characters; max ${style.title_max}`);
  if (bullets.length > style.bullets_max) problems.push(`summary has ${bullets.length} bullets; max ${style.bullets_max}`);
  for (const [i, text] of bullets.entries()) {
    if (text.length === 0) problems.push(`bullet ${i + 1} is empty`);
    if (text.length > style.bullet_max) problems.push(`bullet ${i + 1} is ${text.length} characters; max ${style.bullet_max}`);
  }
  const framing = /\bin this (clip|excerpt|snip|segment)\b/i;
  if (framing.test(title) || bullets.some((b) => framing.test(b))) problems.push('summary refers to "this clip"');

  const ids = new Set(input.excerpt.map((s) => s.id));
  for (const [i, bullet] of out.bullets.entries()) {
    const bad = bullet.sentence_ids.filter((id) => !ids.has(id));
    if (bad.length > 0) problems.push(`bullet ${i + 1} cites sentence ids not in the excerpt: ${bad.join(", ")}`);
  }

  const excerptText = input.excerpt.map((s) => s.text).join(" ");
  const allowed = [excerptText, input.context.episode_title, input.context.show_title, Object.values(input.context.speaker_names ?? {}).join(" "), "host guest"];
  // Each bullet is read on its own, so its first word starts a sentence; a Title Case title is left out, as above.
  const names = unsupportedNames(isTitleCase(title) ? bullets : [title, ...bullets], allowed);
  if (names.length > 0) problems.push(`names not found in the excerpt or metadata: ${names.join(", ")}`);

  const quote = out.quote.trim();
  if (quote.length > 0) {
    if (quote.length < style.quote_min || quote.length > style.quote_max) problems.push(`quote is ${quote.length} characters; keep it between ${style.quote_min} and ${style.quote_max} or leave it empty`);
    if (!quoteKey(excerptText).includes(quoteKey(quote))) problems.push("quote is not word for word from the excerpt; copy it exactly or leave it empty");
  }
  return problems;
}

/** Title used when no summary could be validated: the first eight words of the excerpt. */
export function fallbackTitle(excerpt: Sentence[]): string {
  return fallbackTitleFromText(excerpt.map((s) => s.text).join(" "));
}

/** The same title from an excerpt stored as plain text. */
export function fallbackTitleFromText(text: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  const head = words.slice(0, 8).join(" ").replace(/[,;:]$/, "");
  return words.length > 8 ? `${head}…` : head;
}

/**
 * Generate, validate, and regenerate once with the problems appended. Never returns unvalidated text as ok.
 */
export async function summarizeSnip(input: SnipSummaryInput, model: TextModel, opts: { timeout_ms?: number; version?: string } = {}): Promise<SnipSummaryResult> {
  const style = { ...DEFAULT_SNIP_BULLETS_STYLE, ...input.style };
  const base = buildSnipSummaryPrompt(input, opts.version);
  let problems: string[] = [];
  let modelName: string | null = null;
  let firstProblems: string[] = [];
  let attemptsMade = 0;
  let transportError = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    attemptsMade = attempt;
    const user = attempt === 1 ? base.user : `${base.user}\n\nYour previous answer was rejected for these reasons; fix them:\n- ${problems.join("\n- ")}`;
    try {
      const res = await model.generate({ system: base.system, user, schema: SnipBulletsSchema, ...(opts.timeout_ms ? { timeout_ms: opts.timeout_ms } : {}) });
      modelName = res.model;
      problems = validateSnipBullets(res.data, input, style);
      if (attempt === 1) firstProblems = problems;
      if (problems.length === 0) {
        const bullets = res.data.bullets.map((b) => ({ ...b, text: cleanBullet(b.text) }));
        const quote = res.data.quote.trim();
        return {
          ok: true, title: res.data.title.trim(), summary: bullets.map((b) => b.text).join("\n"), bullets, quote: quote.length > 0 ? quote : null,
          model: res.model, prompt_version: base.version, attempts: attempt, problems_on_first_try: firstProblems,
        };
      }
    } catch (err) {
      problems = [err instanceof SchemaMismatchError ? err.message : `model call failed: ${err instanceof Error ? err.message : String(err)}`];
      if (attempt === 1) firstProblems = problems;
      if (!(err instanceof SchemaMismatchError)) {
        transportError = true;
        break; // a transport failure is for the job's retry policy, not a reprompt
      }
    }
  }
  return { ok: false, problems, fallback_title: fallbackTitle(input.excerpt), model: modelName, prompt_version: base.version, attempts: attemptsMade, transport_error: transportError };
}

export function countSentences(text: string): number {
  const parts = text.split(/(?<=[.!?]["”’)]*)\s+(?=[\p{Lu}"“(])/u).filter((p) => p.trim().length > 0);
  return Math.max(1, parts.length);
}
