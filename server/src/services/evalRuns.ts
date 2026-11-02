import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AppContext } from "../app/context.js";
import { conflict, notFound } from "../app/errors.js";
import { readRegistry, type PromptName } from "../core/summary/prompts.js";
import { runSelectionEval, selectionDir } from "../evals/snip-selection/run.js";
import { appEditCases } from "../evals/snip-titles/appEdits.js";
import { codexLabel, runStamp, runTitleEval, titlesDir } from "../evals/snip-titles/run.js";
import { NonRetryable } from "../jobs/errors.js";
import { PRIORITY, type Job, type JobRow } from "../jobs/queue.js";
import { commitFiles } from "../lib/git.js";

/**
 * Evals the Prompts screen can run, one per prompt that has one. Each run is scored as a pass rate over its cases:
 * titles pass when the judge says the title makes the owner's point (4 or 5 of 5; a title that fails validation
 * fails), starts pass when both boundaries need no edit. Results are the same files the eval CLIs write.
 */
export type EvalId = "titles" | "selection";
type EvalDef = { id: EvalId; label: string; prompt: PromptName; dir: () => string; file: RegExp };
export const EVALS: EvalDef[] = [
  { id: "titles", label: "Titles", prompt: "snip-summary", dir: titlesDir, file: /^(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d)-titles\.json$/ },
  { id: "selection", label: "Starts", prompt: "span-picker", dir: selectionDir, file: /^(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d)-selection\.json$/ },
];

export type Score = { passed: number; n: number; rate: number; margin: number };
export type RunView = { id: string; eval: EvalId; version: string | null; run_at: number; status: "queued" | "running" | "done" | "failed"; score: Score | null; progress: { done: number; total: number } | null; error: string | null };
export type CaseView = { id: string; pass: boolean; score: number | null; expected: string; actual: string; note: string | null };

export function evalDef(id: string): EvalDef {
  const def = EVALS.find((e) => e.id === id);
  if (!def) throw notFound("eval");
  return def;
}
export function evalForPrompt(name: PromptName): EvalDef | null {
  return EVALS.find((e) => e.prompt === name) ?? null;
}

/** Pass rate with the half-width of its 95% Wilson interval, so a small run shows how much it can move by chance. */
export function score(passed: number, n: number): Score {
  if (n === 0) return { passed, n, rate: 0, margin: 0 };
  const z = 1.96;
  const p = passed / n;
  const denom = 1 + (z * z) / n;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { passed, n, rate: p, margin: half };
}

type TitleRow = { id: string; show: string | null; reference: string; candidate: string | null; failed: string | null; score: number | null; missing: string | null };
type SelectionRow = { case_id: string; method: string; both: boolean; start_hit: boolean; end_hit: boolean; duration_ms: number };
type Parsed = { version: string | null; run_at: number; score: Score; cases: () => CaseView[] };

// Result files are large (a selection run keeps every method's rows), so parse each once per modification.
const parsedCache = new Map<string, { mtime: number; parsed: Parsed | null }>();

function parseRun(def: EvalDef, path: string): Parsed | null {
  const mtime = statSync(path).mtimeMs;
  const hit = parsedCache.get(path);
  if (hit && hit.mtime === mtime) return hit.parsed;
  let parsed: Parsed | null = null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as { meta: Record<string, unknown>; rows: unknown[] };
    parsed = def.id === "titles" ? parseTitles(data) : parseSelection(data);
  } catch {
    parsed = null;
  }
  parsedCache.set(path, { mtime, parsed });
  return parsed;
}

function parseTitles(data: { meta: Record<string, unknown>; rows: unknown[] }): Parsed {
  const rows = data.rows as TitleRow[];
  const pass = (r: TitleRow) => r.score !== null && r.score >= 4;
  return {
    version: typeof data.meta.prompt === "string" ? data.meta.prompt : null,
    run_at: Date.parse(String(data.meta.run_at)),
    score: score(rows.filter(pass).length, rows.length),
    cases: () =>
      rows
        .map((r) => ({ id: r.id, pass: pass(r), score: r.score, expected: r.reference, actual: r.candidate ?? `Failed: ${r.failed ?? "no title"}`, note: r.missing && r.missing !== "nothing" ? r.missing : null }))
        .sort((a, b) => Number(a.pass) - Number(b.pass) || (a.score ?? 0) - (b.score ?? 0)),
  };
}

/** Only runs that include the model's start pick test the prompt; v2 of the selector is when the current prompt began. */
function parseSelection(data: { meta: Record<string, unknown>; rows: unknown[] }): Parsed | null {
  const method = typeof data.meta.model === "string" ? data.meta.model : null;
  if (!method || !method.startsWith("snap-90+model") || data.meta.selector !== "select_v2") return null;
  const rows = (data.rows as SelectionRow[]).filter((r) => r.method === method);
  const mark = (hit: boolean) => (hit ? "✓" : "✗");
  const ideas = caseIdeas();
  return {
    version: typeof data.meta.prompt === "string" ? data.meta.prompt : "v1",
    run_at: Date.parse(String(data.meta.run_at)),
    score: score(rows.filter((r) => r.both).length, rows.length),
    cases: () =>
      rows
        .map((r) => ({ id: r.case_id, pass: r.both, score: null, expected: ideas.get(r.case_id) ?? r.case_id, actual: `Start ${mark(r.start_hit)}  End ${mark(r.end_hit)}  ${Math.round(r.duration_ms / 1000)} s`, note: null }))
        .sort((a, b) => Number(a.pass) - Number(b.pass) || a.id.localeCompare(b.id)),
  };
}

let ideasCache: Map<string, string> | null = null;
/** What each selection case is about (the Snipd title or first sentence), from the case files, read once. */
function caseIdeas(): Map<string, string> {
  if (ideasCache) return ideasCache;
  const out = new Map<string, string>();
  const dir = join(selectionDir(), "cases");
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json") || f === "index.json") continue;
      try {
        const c = JSON.parse(readFileSync(join(dir, f), "utf8")) as { id: string; label?: { idea?: string } };
        if (c.label?.idea) out.set(c.id, c.label.idea);
      } catch {
        // skip an unreadable case
      }
    }
  }
  ideasCache = out;
  return out;
}

function resultFiles(def: EvalDef): { id: string; path: string }[] {
  const dir = join(def.dir(), "results");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const m = def.file.exec(f);
    return m ? [{ id: m[1]!, path: join(dir, f) }] : [];
  });
}

// Progress of runs in this process, by run id; a run started before a restart shows as running without it.
const progress = new Map<string, { done: number; total: number }>();

/** Every run of an eval, newest first: finished ones from their result files, the rest from the job queue. */
export function listRuns(ctx: AppContext, id: EvalId): RunView[] {
  const def = evalDef(id);
  const runs = new Map<string, RunView>();
  for (const f of resultFiles(def)) {
    const p = parseRun(def, f.path);
    if (p) runs.set(f.id, { id: f.id, eval: id, version: p.version, run_at: p.run_at, status: "done", score: p.score, progress: null, error: null });
  }
  const jobs = ctx.db.prepare("SELECT * FROM job WHERE kind = 'eval_run' AND key LIKE ? AND status != 'done'").all(`eval_run:${id}:%`) as JobRow[];
  for (const j of jobs) {
    const payload = JSON.parse(j.payload) as { version: string; stamp: string };
    if (runs.has(payload.stamp)) continue;
    const status = j.status === "running" ? "running" : j.status === "failed" ? "failed" : "queued";
    runs.set(payload.stamp, { id: payload.stamp, eval: id, version: payload.version, run_at: j.created_at, status, score: null, progress: progress.get(payload.stamp) ?? null, error: j.status === "failed" ? j.last_error : null });
  }
  return [...runs.values()].sort((a, b) => b.run_at - a.run_at);
}

/** The latest finished run's score for each version. */
export function latestScores(ctx: AppContext, id: EvalId): Map<string, Score> {
  const out = new Map<string, Score>();
  for (const r of listRuns(ctx, id)) if (r.status === "done" && r.version && r.score && !out.has(r.version)) out.set(r.version, r.score);
  return out;
}

export function getRun(ctx: AppContext, id: EvalId, runId: string): { run: RunView; cases: CaseView[] } {
  const def = evalDef(id);
  const run = listRuns(ctx, id).find((r) => r.id === runId);
  if (!run) throw notFound("run");
  const file = resultFiles(def).find((f) => f.id === runId);
  const parsed = file ? parseRun(def, file.path) : null;
  return { run, cases: parsed ? parsed.cases() : [] };
}

/** Queue a run of one prompt version on the eval's standard case set. A run already waiting for that version is returned. */
export function startRun(ctx: AppContext, id: EvalId, version: string): RunView {
  const def = evalDef(id);
  if (!readRegistry()[def.prompt].versions[version]) throw notFound("prompt version");
  if (!ctx.textModel) throw conflict("no text model is configured (TEXT_MODEL=codex-cli)");
  const pending = listRuns(ctx, id).find((r) => r.version === version && (r.status === "queued" || r.status === "running"));
  if (pending) return pending;
  const stamp = runStamp(new Date(ctx.now()));
  ctx.queue.enqueue("eval_run", `eval_run:${id}:${stamp}`, { eval: id, version, stamp }, { priority: PRIORITY.catalog });
  return listRuns(ctx, id).find((r) => r.id === stamp)!;
}

/** Job body: run the eval, then commit its scorecard so scores stay in the repository's history like the prompts. */
export async function evalRunJob(ctx: AppContext, job: Job<{ eval: EvalId; version: string; stamp: string }>): Promise<void> {
  const def = evalDef(job.payload.eval);
  const { version, stamp } = job.payload;
  if (!ctx.textModel) throw new NonRetryable("no text model is configured");
  const label = codexLabel(ctx.config.codexModel, ctx.config.codexReasoningEffort);
  const onProgress = (done: number, total: number) => progress.set(stamp, { done, total });
  progress.set(stamp, { done: 0, total: 0 });
  try {
    if (def.id === "titles") await runTitleEval({ version, model: ctx.textModel, modelLabel: label, stamp, appEdits: appEditCases(ctx), onProgress });
    else await runSelectionEval({ version, model: ctx.textModel, modelLabel: `snap-90+model (${label})`, stamp, onProgress });
  } catch (err) {
    // A failed run is not retried on its own: it may be dozens of model calls, and the cache keeps what finished.
    throw new NonRetryable(err instanceof Error ? err.message : String(err));
  } finally {
    progress.delete(stamp);
  }
  const scorecard = join(def.dir(), "results", `${stamp}-${def.id === "titles" ? "titles" : "selection"}.md`);
  await commitFiles([scorecard], `Eval ${def.label.toLowerCase()}: ${def.prompt} ${version}`, ctx.log, { push: ctx.config.gitAutoPush });
}
