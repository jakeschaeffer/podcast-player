/**
 * Segment → title eval: generate a title for each case's excerpt with the app's snip-summary prompt, then score it
 * against the owner's title with a judge model and a cheap word-overlap measure.
 *
 *   pnpm eval:titles:run [--origin manual,appended,app-edit] [--limit 60] [--concurrency 5] [--seed 1]
 *
 * Generations and judgments are cached in results/title-cache.jsonl keyed by case, prompt version, and model, so a
 * rerun after an interruption repeats no calls. Writes results/<timestamp>-titles.{json,md}. The server runs the same
 * function (`runTitleEval`) when a run is started from the Prompts screen.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Type } from "@sinclair/typebox";
import { CodexCliTextModel } from "../../adapters/codex-cli.js";
import { delimited, type TextModel } from "../../adapters/textModel.js";
import type { Sentence } from "../../core/snip/sentencize.js";
import { readRegistry, resolvePrompt } from "../../core/summary/prompts.js";
import { summarizeSnip } from "../../core/summary/snip.js";
import type { TitleCase } from "./cases.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
/** evals/snip-titles at the repository root, or under EVALS_DIR when tests or a local copy point elsewhere. */
export function titlesDir(): string {
  return join(process.env.EVALS_DIR || join(REPO, "evals"), "snip-titles");
}
/** The judge's version as scorecards record it: "judge_v1" for prompts/title-judge/v1.md, and so on. */
export function judgeVersion(): string {
  return `judge_${resolvePrompt("title-judge").version}`;
}

const JudgeSchema = Type.Object({ score: Type.Integer({ minimum: 1, maximum: 5 }), missing: Type.String({ maxLength: 200 }) }, { additionalProperties: false });

/** Turns → numbered sentences in the shape the snip summarizer takes. */
export function toSentences(turns: TitleCase["excerpt"]): Sentence[] {
  const out: Sentence[] = [];
  let w = 0;
  for (const t of turns) {
    const parts = t.text.replace(/\s+/g, " ").split(/(?<=[.?!])\s+(?=[A-Z"“(])/).map((x) => x.trim()).filter(Boolean);
    for (const text of parts) {
      const n = text.split(" ").length;
      out.push({ id: out.length, speaker: t.speaker, start_word: w, end_word: w + n, start_ms: 0, end_ms: 0, text, word_count: n });
      w += n;
    }
  }
  return out;
}

const STOP = new Set("a an and are as at be but by for from has have how in into is it its of on or that the their them they this to was were what when where which who why will with you your i we our not no do does can about than then so if just".split(" "));
function contentWords(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z0-9][a-z0-9'’-]*/g) ?? []).map((w) => w.replace(/['’]s$/, "").replace(/(ing|ed|es|s)$/, "")).filter((w) => w.length > 2 && !STOP.has(w)));
}
/** Share of the reference title's content words that the candidate also uses. */
export function wordRecall(reference: string, candidate: string): number {
  const ref = contentWords(reference);
  if (ref.size === 0) return 1;
  const cand = contentWords(candidate);
  return [...ref].filter((w) => cand.has(w)).length / ref.size;
}

type CacheEntry = { key: string; value: unknown };
/** Generations and judgments by key, read from and appended to results/title-cache.jsonl. */
function openCache(path: string): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const cache = new Map<string, unknown>();
  if (existsSync(path)) for (const line of readFileSync(path, "utf8").split("\n")) { if (!line.trim()) continue; try { const e = JSON.parse(line) as CacheEntry; cache.set(e.key, e.value); } catch { /* torn line */ } }
  return async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    if (cache.has(key)) return cache.get(key) as T;
    const value = await fn();
    cache.set(key, value);
    appendFileSync(path, `${JSON.stringify({ key, value, at: new Date().toISOString() })}\n`);
    return value;
  };
}

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, n) }, async () => { while (next < items.length) await fn(items[next++]!); }));
}

function rank(id: string, seed: string): string {
  return createHash("sha1").update(`${seed}:${id}`).digest("hex");
}

/** Score a candidate title against the listener's own. Exported for the prompt-assembly fingerprint test. */
export async function judge(model: TextModel, c: TitleCase, candidate: string): Promise<{ score: number; missing: string }> {
  const excerpt = c.excerpt.map((t) => `${t.speaker ? `${t.speaker}: ` : ""}${t.text}`).join("\n");
  const user = [`Show: ${c.show ?? ""}`, `Episode: ${c.episode}`, delimited("excerpt", excerpt.slice(0, 12_000)), `Listener's title: ${c.reference_title}`, `Candidate title: ${candidate}`].join("\n\n");
  const res = await model.generate({ system: resolvePrompt("title-judge").text, user, schema: JudgeSchema, timeout_ms: 120_000 });
  return res.data;
}

export type TitleEvalOptions = {
  /** Version of prompts/snip-summary to test; the active one by default. */
  version?: string;
  origins?: string[];
  limit?: number;
  seed?: string;
  concurrency?: number;
  /** The generator and judge, and the label cache keys and scorecards use for it (`codex/low`). */
  model: TextModel;
  modelLabel: string;
  /** Names the result files; the server passes the stamp it showed for the queued run. */
  stamp?: string;
  /** In-app title edits read fresh from the database; replaces cases/app-edits.jsonl when given. */
  appEdits?: TitleCase[];
  onProgress?: (done: number, total: number) => void;
};

export type TitleEvalMeta = { run_at: string; prompt_name: "snip-summary"; prompt: string; judge: string; model: string; origins: string[]; limit: number; seed: string; cases: number; cases_sha: string };

/** Generate a title for each picked case with one version of the snip-summary prompt, judge it, and write the scorecard. */
export async function runTitleEval(opts: TitleEvalOptions): Promise<{ stamp: string; meta: TitleEvalMeta }> {
  const DIR = titlesDir();
  await mkdir(join(DIR, "results"), { recursive: true });
  const cached = openCache(join(DIR, "results/title-cache.jsonl"));
  const version = opts.version ?? readRegistry()["snip-summary"].active;
  const values = { seed: opts.seed ?? "1", limit: String(opts.limit ?? 60), concurrency: String(opts.concurrency ?? 5) };
  const origins = new Set(opts.origins ?? ["manual", "appended", "app-edit"]);
  const all: TitleCase[] = [];
  for (const f of opts.appEdits ? ["cases/readwise.jsonl"] : ["cases/readwise.jsonl", "cases/app-edits.jsonl"]) {
    const p = join(DIR, f);
    if (existsSync(p)) for (const l of readFileSync(p, "utf8").split("\n")) if (l.trim()) all.push(JSON.parse(l) as TitleCase);
  }
  if (opts.appEdits) all.push(...opts.appEdits);
  if (all.length === 0) throw new Error("no title cases; run eval:titles:build first");
  // Every app edit, then a seeded spread of the rest, so a small run still covers many shows.
  const picked = all.filter((c) => origins.has(c.origin)).sort((a, b) => (a.source === b.source ? rank(a.id, values.seed).localeCompare(rank(b.id, values.seed)) : a.source === "app" ? -1 : 1)).slice(0, Number(values.limit));

  const model = opts.model;
  const modelLabel = opts.modelLabel;
  type Row = { id: string; origin: string; show: string | null; reference: string; candidate: string | null; failed: string | null; score: number | null; missing: string | null; recall: number | null; other: string | null; other_score: number | null; other_recall: number | null; ref_chars: number; cand_chars: number | null };
  const rows: Row[] = [];
  let done = 0;
  const started = Date.now();
  await pool(picked, Number(values.concurrency), async (c) => {
    const sentences = toSentences(c.excerpt);
    const speakers = Object.fromEntries(c.excerpt.filter((t) => t.speaker).map((t) => [t.speaker!, t.speaker!]));
    const gen = await cached(`gen|${version}|${modelLabel}|${c.id}`, async () => {
      const r = await summarizeSnip({ excerpt: sentences, context: { show_title: c.show ?? "", episode_title: c.episode, speaker_names: speakers } }, model, { timeout_ms: 180_000, version });
      return r.ok ? { title: r.title, problems: [] as string[] } : { title: null, problems: r.problems };
    });
    let score: number | null = null, missing: string | null = null;
    if (gen.title) {
      const j = await cached(`judge|${judgeVersion()}|${modelLabel}|${c.id}|${gen.title}`, () => judge(model, c, gen.title!));
      score = j.score; missing = j.missing;
    }
    let otherScore: number | null = null;
    if (c.other_model_title) otherScore = (await cached(`judge|${judgeVersion()}|${modelLabel}|${c.id}|${c.other_model_title}`, () => judge(model, c, c.other_model_title!))).score;
    rows.push({
      id: c.id, origin: c.origin, show: c.show, reference: c.reference_title, candidate: gen.title, failed: gen.title ? null : gen.problems.join("; "),
      score, missing, recall: gen.title ? wordRecall(c.reference_title, gen.title) : null,
      other: c.other_model_title ?? null, other_score: otherScore, other_recall: c.other_model_title ? wordRecall(c.reference_title, c.other_model_title) : null,
      ref_chars: c.reference_title.length, cand_chars: gen.title?.length ?? null,
    });
    done++;
    opts.onProgress?.(done, picked.length);
    if (done % 10 === 0 || done === picked.length) console.error(`titles: ${done}/${picked.length} cases, ${((Date.now() - started) / 1000).toFixed(0)} s`);
  });
  rows.sort((a, b) => a.id.localeCompare(b.id));

  const mean = (xs: (number | null)[]) => { const v = xs.filter((x): x is number => x !== null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const share = (xs: (number | null)[], f: (x: number) => boolean) => { const v = xs.filter((x): x is number => x !== null); return v.length ? v.filter(f).length / v.length : null; };
  const median = (xs: (number | null)[]) => { const v = xs.filter((x): x is number => x !== null).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)]! : null; };
  const group = (name: string, rs: Row[]) => ({
    group: name, n: rs.length,
    generated: rs.filter((r) => r.candidate).length,
    mean_score: mean(rs.map((r) => r.score)), same_point: share(rs.map((r) => r.score), (x) => x >= 4), exact: share(rs.map((r) => r.score), (x) => x === 5),
    word_recall: mean(rs.map((r) => r.recall)), median_chars_owner: median(rs.map((r) => r.ref_chars)), median_chars_model: median(rs.map((r) => r.cand_chars)),
    other_n: rs.filter((r) => r.other_score !== null).length, other_mean_score: mean(rs.map((r) => r.other_score)),
  });
  const groups = [group("all", rows), ...[...new Set(rows.map((r) => r.origin))].sort().map((o) => group(o, rows.filter((r) => r.origin === o)))];
  const pct = (x: number | null) => (x === null ? "–" : `${Math.round(x * 100)}%`);
  const num = (x: number | null, d = 2) => (x === null ? "–" : x.toFixed(d));
  const stamp = opts.stamp ?? runStamp();
  // The case set, so scores are compared only between runs over the same cases.
  const casesSha = createHash("sha256").update(picked.map((c) => `${c.id}\t${c.reference_title}`).join("\n")).digest("hex").slice(0, 12);
  const meta: TitleEvalMeta = { run_at: new Date().toISOString(), prompt_name: "snip-summary", prompt: version, judge: judgeVersion(), model: modelLabel, origins: [...origins], limit: Number(values.limit), seed: values.seed, cases: rows.length, cases_sha: casesSha };
  await mkdir(join(DIR, "results"), { recursive: true });
  await writeFile(join(DIR, "results", `${stamp}-titles.json`), JSON.stringify({ meta, groups, rows }, null, 1));
  const md = [
    `# Segment → title scorecard`,
    ``,
    `Run ${meta.run_at}. Title prompt \`${meta.prompt}\`, judge \`${meta.judge}\`, model \`${meta.model}\`. ${rows.length} cases (${meta.origins.join(", ")}), seed ${meta.seed}.`,
    ``,
    `The judge scores each generated title against the owner's title, 1 to 5: 5 is the same point at least as specific, 4 the same point but vaguer, 3 related with a different emphasis, 2 mostly a different point, 1 wrong. "Same point" is 4 or 5. Word recall is the share of the owner's content words the generated title also uses. For appended titles, Snipd's headline is scored the same way.`,
    ``,
    `| Group | n | Titles generated | Mean score | Same point | Exact | Word recall | Owner title, median chars | Model title, median chars | Snipd headline mean score (n) |`,
    `| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |`,
    ...groups.map((g) => `| ${g.group} | ${g.n} | ${g.generated} | ${num(g.mean_score)} | ${pct(g.same_point)} | ${pct(g.exact)} | ${pct(g.word_recall)} | ${g.median_chars_owner ?? "–"} | ${g.median_chars_model ?? "–"} | ${g.other_n ? `${num(g.other_mean_score)} (${g.other_n})` : "–"} |`),
    ``,
    // The case-by-case table (the owner's own titles beside the model's) stays in the JSON, which is not committed:
    // the markdown scorecard is, and it is read by whoever can read the repository.
    `Per case: \`results/${stamp}-titles.json\` (not committed; it quotes the owner's titles).`,
    ``,
  ].join("\n");
  await writeFile(join(DIR, "results", `${stamp}-titles.md`), md);
  return { stamp, meta };
}

/** 2026-10-25T12-00-00: names a run's result files. */
export function runStamp(at: Date = new Date()): string {
  return at.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { origin: { type: "string", default: "manual,appended,app-edit" }, limit: { type: "string", default: "60" }, concurrency: { type: "string", default: "5" }, seed: { type: "string", default: "1" }, version: { type: "string" } } });
  const model = new CodexCliTextModel({ model: process.env.CODEX_MODEL ?? "", reasoningEffort: process.env.CODEX_REASONING_EFFORT ?? "" });
  const { stamp } = await runTitleEval({
    model,
    modelLabel: codexLabel(process.env.CODEX_MODEL ?? "", process.env.CODEX_REASONING_EFFORT ?? ""),
    origins: values.origin!.split(","),
    limit: Number(values.limit),
    seed: values.seed!,
    concurrency: Number(values.concurrency),
    ...(values.version ? { version: values.version } : {}),
  });
  console.log(readFileSync(join(titlesDir(), "results", `${stamp}-titles.md`), "utf8"));
  console.log(`wrote ${join(titlesDir(), "results", `${stamp}-titles.{json,md}`)}`);
}

/** `codex`, `codex/low`, or `codex:<model>/low`: the label scorecards and cache keys use for the Codex settings. */
export function codexLabel(model: string, effort: string): string {
  return `codex${model ? `:${model}` : ""}${effort ? `/${effort}` : ""}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err instanceof Error ? err.stack ?? err.message : String(err)); process.exit(1); });
}
