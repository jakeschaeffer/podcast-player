/**
 * Who a transcript's voices are. Transcription labels them S1, S2… by order of first appearance; this decides, per
 * label, whether it is the show's host, a guest the host is talking with, or someone else (a clip from another show,
 * an ad, a quote read aloud), and names it only when the publisher says who it is: the show's author, the show and
 * episode titles, or the show notes. A name heard only in the audio is never used, the same rule as snip summaries.
 */
import { Type, type Static } from "@sinclair/typebox";
import { delimited, SchemaMismatchError, type TextModel } from "../../adapters/textModel.js";
import { resolvePrompt } from "../summary/prompts.js";
import type { NormalizedTranscript } from "../transcript/types.js";

export const SpeakersSchema = Type.Object(
  {
    speakers: Type.Array(
      Type.Object({
        label: Type.String({ minLength: 1, maxLength: 12 }),
        role: Type.Union([Type.Literal("host"), Type.Literal("guest"), Type.Literal("other")]),
        name: Type.String({ maxLength: 80 }),
      }),
      { maxItems: 16 },
    ),
  },
  { additionalProperties: false },
);
export type SpeakersOutput = Static<typeof SpeakersSchema>;

export type SpeakerRole = "host" | "guest" | "other";
/** One label's identity; `name` is null when the publisher does not say who it is. */
export type SpeakerIdentity = { label: string; role: SpeakerRole; name: string | null };

/** What the model is shown about one label: how much it speaks, how many questions it asks, and its first lines. */
export type LabelSample = { label: string; share: number; turns: number; questions: number; lines: string[] };

export type SpeakersInput = {
  show_title: string;
  /** The feed's author: often the host's name, sometimes a company. */
  author: string | null;
  episode_title: string;
  /** Show notes as plain text; only the start is sent. */
  description_text: string;
  labels: LabelSample[];
};

export type SpeakersResult =
  | { ok: true; speakers: SpeakerIdentity[]; model: string; prompt_version: string; attempts: number }
  | { ok: false; problems: string[]; model: string | null; prompt_version: string; attempts: number; transport_error: boolean };

const LINES_PER_LABEL = 4;
const LINE_MAX = 240;
const NOTES_MAX = 2_000;

/** Per label, in order of first appearance: its share of the words, its turns, its questions, and its first lines. */
export function speakerSamples(t: NormalizedTranscript): LabelSample[] {
  const total = Math.max(1, t.segments.reduce((n, s) => n + s.words.length, 0));
  const by = new Map<string, { words: number; turns: number; questions: number; lines: string[] }>();
  let previous: string | null = null;
  for (const s of t.segments) {
    if (!s.speaker) continue;
    const entry = by.get(s.speaker) ?? { words: 0, turns: 0, questions: 0, lines: [] };
    entry.words += s.words.length;
    if (s.speaker !== previous) entry.turns += 1;
    entry.questions += (s.text.match(/\?/g) ?? []).length;
    if (entry.lines.length < LINES_PER_LABEL) entry.lines.push(s.text.length > LINE_MAX ? `${s.text.slice(0, LINE_MAX)}…` : s.text);
    by.set(s.speaker, entry);
    previous = s.speaker;
  }
  return [...by.entries()].map(([label, e]) => ({ label, share: Math.round((e.words / total) * 100) / 100, turns: e.turns, questions: e.questions, lines: e.lines }));
}

/** The active version of prompts/speakers unless `version` names another. */
export function buildSpeakersPrompt(input: SpeakersInput, version?: string): { system: string; user: string; version: string } {
  const prompt = resolvePrompt("speakers", version);
  const notes = input.description_text.trim().slice(0, NOTES_MAX);
  const labels = input.labels
    .map((l) => `${l.label}: ${Math.round(l.share * 100)}% of the words, ${l.turns} turns, ${l.questions} questions\n${l.lines.map((x) => `  "${x}"`).join("\n")}`)
    .join("\n\n");
  const lines = [
    `Show: ${input.show_title}`,
    `Author: ${input.author ?? "(none)"}`,
    `Episode: ${input.episode_title}`,
    notes ? delimited("show_notes", notes) : null,
    delimited("transcript", labels),
  ].filter((l): l is string => l !== null);
  return { system: prompt.text, user: lines.join("\n\n"), version: prompt.version };
}

/** Text compared when checking that a name comes from the publisher: lower case, straight apostrophes, single spaces. */
function nameKey(text: string): string {
  return text.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
}

/** Everything that must hold before an answer is stored. Empty array means valid. */
export function validateSpeakers(out: SpeakersOutput, input: SpeakersInput): string[] {
  const problems: string[] = [];
  const known = new Set(input.labels.map((l) => l.label));
  const seen = new Set<string>();
  for (const s of out.speakers) {
    if (!known.has(s.label)) problems.push(`${s.label} is not a label in the transcript`);
    else if (seen.has(s.label)) problems.push(`${s.label} is listed more than once`);
    seen.add(s.label);
  }
  const missing = [...known].filter((l) => !seen.has(l));
  if (missing.length > 0) problems.push(`give every label a role; missing: ${missing.join(", ")}`);
  const allowed = nameKey([input.author ?? "", input.show_title, input.episode_title, input.description_text].join(" \n "));
  for (const s of out.speakers) {
    const name = s.name.trim();
    if (name && !allowed.includes(nameKey(name))) problems.push(`the name "${name}" for ${s.label} is not in the author, titles, or show notes; leave it empty`);
    if (name && s.role === "other") problems.push(`${s.label} is "other" but has a name; name only the host and guests`);
  }
  return problems;
}

/** Ask, check, and ask once more with the problems; never returns an unchecked answer as ok. */
export async function identifySpeakers(input: SpeakersInput, model: TextModel, opts: { version?: string; timeout_ms?: number } = {}): Promise<SpeakersResult> {
  const base = buildSpeakersPrompt(input, opts.version);
  let problems: string[] = [];
  let modelName: string | null = null;
  let attempts = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    attempts = attempt;
    const user = attempt === 1 ? base.user : `${base.user}\n\nYour previous answer was rejected for these reasons; fix them:\n- ${problems.join("\n- ")}`;
    try {
      const res = await model.generate({ system: base.system, user, schema: SpeakersSchema, ...(opts.timeout_ms ? { timeout_ms: opts.timeout_ms } : {}) });
      modelName = res.model;
      problems = validateSpeakers(res.data, input);
      if (problems.length === 0) {
        const speakers = res.data.speakers.map((s) => ({ label: s.label, role: s.role, name: s.name.trim() || null }));
        return { ok: true, speakers, model: res.model, prompt_version: base.version, attempts };
      }
    } catch (err) {
      problems = [err instanceof SchemaMismatchError ? err.message : `model call failed: ${err instanceof Error ? err.message : String(err)}`];
      if (!(err instanceof SchemaMismatchError)) {
        return { ok: false, problems, model: modelName, prompt_version: base.version, attempts, transport_error: true };
      }
    }
  }
  return { ok: false, problems, model: modelName, prompt_version: base.version, attempts, transport_error: false };
}

/**
 * What a label is shown as, or null for no heading. Labels come in two kinds. Speech recognition's ("S1", "S2") show
 * as the name when known, else "Host" or "Guest", else "Speaker 2". Publisher text's are already names ("Ari Emanuel",
 * "Host", initials): the name identified for them, else the label as written; its "Quote" (a passage the text quotes)
 * and unlabelled prose have no heading. The rule is contracts/golden/speakers/speaker_names_v1.json; the web app and
 * the native app replay it.
 */
export function speakerDisplayName(label: string | null, speakers: SpeakerIdentity[] | null): string | null {
  if (!label || label === QUOTE_LABEL) return null;
  const who = speakers?.find((s) => s.label === label);
  if (who?.name) return who.name;
  if (!ASR_LABEL.test(label)) return label;
  if (who?.role === "host") return "Host";
  if (who?.role === "guest") return "Guest";
  return `Speaker ${label.slice(1)}`;
}

/** How publisher text marks a quoted passage (services/publisherText.ts). */
export const QUOTE_LABEL = "Quote";
/** Speech recognition's labels, numbered in order of first appearance by normalize(). */
const ASR_LABEL = /^S\d+$/;

/** A clip's words in turns, each under the heading to show for it (null: none). */
export type NamedTurn = { speaker: string | null; name: string | null; text: string };

/**
 * A clip's words by voice, for the snip pages: turns that show under the same heading (or under none) run together,
 * and the turns are worth showing only when more than one heading results; otherwise null, and the clip reads as one
 * block. So an article's prose and the passages it quotes are one block, and an interview's turns carry names.
 */
export function clipTurns(turns: { speaker: string | null; text: string }[], speakers: SpeakerIdentity[] | null): NamedTurn[] | null {
  const out: NamedTurn[] = [];
  for (const t of turns) {
    const name = speakerDisplayName(t.speaker, speakers);
    const last = out[out.length - 1];
    if (last && last.name === name) last.text += ` ${t.text}`;
    else out.push({ speaker: t.speaker, name, text: t.text });
  }
  return out.length > 1 ? out : null;
}
