/**
 * Score span selectors against the eval cases.
 *
 *   pnpm eval:snips:run [--cases-dir cases|cases-text] [--filter <substring of case id>] [--tag show:stratechery] [--limit N]
 *                       [--app] [--model] [--concurrency 4] [--model-timeout-ms 90000]
 *
 * Cases come from two places: the files `eval:snips:build` writes from a Readwise export (simulated taps on the
 * owner's Snipd snips), and with --app the snips made in this app, read from the database (real taps, labelled with
 * the span the owner left; appSnips.ts). Either may be missing. `--tag source:app` scores the app's alone.
 *
 * Methods: fixed-N (the last N seconds before the tap), snap-90 (the production default), snap-90-band15 (scored
 * signals inside a 15 s band), scored-v1 (the first heuristic), and with --model the Codex-backed start picker.
 * Model picks are cached in results/model-picks.jsonl keyed by case, model, and selector version, so an
 * interrupted run resumes without repeating calls. Writes results/<timestamp>-selection.{json,md}. The server runs the
 * same function (`runSelectionEval`, always with the model and the app's snips) when a run is started from the
 * Prompts screen.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { CodexCliTextModel } from "../../adapters/codex-cli.js";
import { createContext } from "../../app/context.js";
import { loadConfig } from "../../lib/config.js";
import { DEFAULT_SELECT_PREFS, SELECTOR_VERSION, selectSpan, type Selection, type SpanPicker } from "../../core/snip/select.js";
import type { TextModel } from "../../adapters/textModel.js";
import { readRegistry } from "../../core/summary/prompts.js";
import { makeSpanPicker } from "../../services/spanPicker.js";
import { SENTENCIZER_VERSION } from "../../core/snip/sentencize.js";
import { sliceWords } from "../../core/transcript/normalize.js";
import type { ApiTranscript, NormalizedTranscript } from "../../core/transcript/types.js";
import { appSnipCases, editNote, type AppCases } from "./appSnips.js";
import { isAppCase, type SnipCase } from "./cases.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
/** evals/snip-selection at the repository root, or under EVALS_DIR when tests or a local copy point elsewhere. */
export function selectionDir(): string {
  return join(process.env.EVALS_DIR || join(REPO, "evals"), "snip-selection");
}

type Method = { name: string; run: (t: NormalizedTranscript, c: SnipCase, duration_ms: number) => Promise<Selection> };

const METHODS: Method[] = [
  ...[60, 90, 180].map((n) => ({
    name: `fixed-${n}`,
    run: (_t: NormalizedTranscript, c: SnipCase, duration_ms: number) =>
      selectSpan({ transcript: null, anchor_ms: c.anchor_ms, heard_from_ms: c.heard_from_ms, duration_ms, prefs: { target_ms: n * 1000, max_ms: Math.max(n, 180) * 1000 } }),
  })),
  // The production default: latest sentence end, start nearest 90 s back.
  {
    name: "snap-90",
    run: (t: NormalizedTranscript, c: SnipCase, duration_ms: number) => selectSpan({ transcript: t, anchor_ms: c.anchor_ms, heard_from_ms: c.heard_from_ms, duration_ms }),
  },
  // Scored signals decide among starts within 15 s of the nearest-to-target distance.
  {
    name: "snap-90-band15",
    run: (t: NormalizedTranscript, c: SnipCase, duration_ms: number) =>
      selectSpan({ transcript: t, anchor_ms: c.anchor_ms, heard_from_ms: c.heard_from_ms, duration_ms, prefs: { snap_band_ms: 15_000 } }),
  },
  // The v1 behaviour: scored over every valid start (unbounded band), 60 s target, 45–120 s "good length".
  {
    name: "scored-v1",
    run: (t: NormalizedTranscript, c: SnipCase, duration_ms: number) =>
      selectSpan({ transcript: t, anchor_ms: c.anchor_ms, heard_from_ms: c.heard_from_ms, duration_ms, prefs: { snap_band_ms: Number.POSITIVE_INFINITY, target_ms: 60_000, good_min_ms: 45_000, good_max_ms: 120_000 } }),
  },
];

type Row = {
  case_id: string;
  method: string;
  start_ms: number;
  end_ms: number;
  start_hit: boolean;
  end_hit: boolean;
  both: boolean;
  iou: number;
  over_capture_ms: number;
  under_capture_ms: number;
  duration_ms: number;
  selection_method: Selection["method"];
  model_rejection: string | null;
  violations: string[];
  latency_ms: number;
  tags: string[];
  /** For a snip made in the app, which has no case file to look these up in: what it is, and what the owner did to it. */
  idea?: string;
  note?: string;
};

function fromApi(api: ApiTranscript & { duration_ms: number }): NormalizedTranscript {
  return {
    provider: "fixture",
    model: "fixture",
    language: api.language,
    word_count: api.word_count,
    segments: api.segments.map((s, idx) => ({ idx, start_ms: s.s, end_ms: s.e, speaker: s.spk, first_word: s.w0, text: s.words.map((w) => w[2]).join(" "), words: s.words })),
    events: api.events,
  };
}

function score(c: SnipCase, m: string, sel: Selection, latency_ms: number, isHeuristic: boolean, t: NormalizedTranscript): Row {
  const { label } = c;
  // Boundaries are judged on the first and last selected words; lead-in and tail padding are product behaviour, not a boundary choice.
  const words = sel.start_word !== null && sel.end_word !== null && sel.end_word > sel.start_word ? sliceWords(t, sel.start_word, sel.end_word) : null;
  const startRef = words ? words[0]![0] : sel.start_ms;
  const endRef = words ? words[words.length - 1]![1] : sel.end_ms;
  const start_hit = startRef >= label.acceptable_start_ms[0] && startRef <= label.acceptable_start_ms[1];
  const end_hit = endRef >= label.acceptable_end_ms[0] && endRef <= label.acceptable_end_ms[1];
  const inter = Math.max(0, Math.min(sel.end_ms, label.ideal_end_ms) - Math.max(sel.start_ms, label.ideal_start_ms));
  const union = Math.max(sel.end_ms, label.ideal_end_ms) - Math.min(sel.start_ms, label.ideal_start_ms);
  const violations: string[] = [];
  if (sel.start_ms < sel.window.lo_ms) violations.push("start before window");
  if (sel.end_ms > c.anchor_ms) violations.push("end after tap");
  if (isHeuristic && sel.method !== "fixed" && !sel.window.short_exception && !sel.window.min_relaxed) {
    const dur = sel.end_ms - sel.start_ms;
    if (dur < DEFAULT_SELECT_PREFS.min_ms - 500) violations.push("shorter than minimum");
  }
  return {
    case_id: c.id,
    method: m,
    start_ms: sel.start_ms,
    end_ms: sel.end_ms,
    start_hit,
    end_hit,
    both: start_hit && end_hit,
    iou: union > 0 ? inter / union : 0,
    over_capture_ms: Math.max(0, label.ideal_start_ms - sel.start_ms),
    under_capture_ms: Math.max(0, sel.start_ms - label.ideal_start_ms) + Math.max(0, label.ideal_end_ms - sel.end_ms),
    duration_ms: sel.end_ms - sel.start_ms,
    selection_method: sel.method,
    model_rejection: sel.model_rejection,
    violations,
    latency_ms,
    tags: c.tags,
    ...(isAppCase(c) ? { idea: c.label.idea, note: editNote(c) ?? "" } : {}),
  };
}

function pct(n: number, d: number): string {
  return d === 0 ? "–" : `${((100 * n) / d).toFixed(0)}%`;
}
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}
function p95(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]!;
}

function summarize(rows: Row[]) {
  const n = rows.length;
  return {
    n,
    start_hit: pct(rows.filter((r) => r.start_hit).length, n),
    end_hit: pct(rows.filter((r) => r.end_hit).length, n),
    both: pct(rows.filter((r) => r.both).length, n),
    mean_iou: n ? (rows.reduce((a, r) => a + r.iou, 0) / n).toFixed(2) : "–",
    median_over_s: (median(rows.map((r) => r.over_capture_ms)) / 1000).toFixed(1),
    median_under_s: (median(rows.map((r) => r.under_capture_ms)) / 1000).toFixed(1),
    median_duration_s: (median(rows.map((r) => r.duration_ms)) / 1000).toFixed(0),
    fallback: pct(rows.filter((r) => r.selection_method === "fixed").length, n),
    model_used: pct(rows.filter((r) => r.selection_method === "model").length, n),
    model_rejected: pct(rows.filter((r) => r.model_rejection !== null && !r.model_rejection.startsWith("picker failed")).length, n),
    model_failed: pct(rows.filter((r) => r.model_rejection !== null && r.model_rejection.startsWith("picker failed")).length, n),
    violations: rows.reduce((a, r) => a + r.violations.length, 0),
    p95_latency_ms: p95(rows.map((r) => r.latency_ms)),
  };
}

/** A picker that replays cached answers and appends new ones, so an interrupted run never repeats a model call. */
function cachedPicker(inner: SpanPicker, cachePath: string, keyPrefix: string): { picker: (caseId: string) => SpanPicker; hits: () => number } {
  const cache = new Map<string, { start_id: number; reason: string } | null>();
  if (existsSync(cachePath)) {
    for (const line of require_fs().readFileSync(cachePath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as { key: string; pick: { start_id: number; reason: string } | null };
        cache.set(e.key, e.pick);
      } catch {
        // skip a torn line
      }
    }
  }
  let hits = 0;
  return {
    hits: () => hits,
    picker: (caseId) => async (input) => {
      const key = `${keyPrefix}|${caseId}`;
      if (cache.has(key)) { hits++; return cache.get(key)!; }
      const pick = await inner(input);
      cache.set(key, pick);
      appendFileSync(cachePath, `${JSON.stringify({ key, pick, at: new Date().toISOString() })}\n`);
      return pick;
    },
  };
}
import * as fsModule from "node:fs";
function require_fs() { return fsModule; }

async function pool<T>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
}

export type SelectionEvalOptions = {
  casesDir?: string;
  /** Snips made in the app, as cases (`appSnipCases`); they join whatever case files there are. */
  app?: AppCases;
  filter?: string;
  tag?: string;
  limit?: number;
  /** With a model, the start picker runs on every case as one more method. */
  model?: TextModel;
  /** Label for the model method and the pick cache, e.g. `snap-90+model (codex/low)`. */
  modelLabel?: string;
  /** Version of prompts/span-picker to test; the active one by default. */
  version?: string;
  concurrency?: number;
  modelTimeoutMs?: number;
  stamp?: string;
  onProgress?: (done: number, total: number) => void;
};

export type SelectionEvalMeta = { selector: string; sentencizer: string; model: string | null; prompt_name: "span-picker"; prompt: string | null; cases_dir: string; cases: number; snips: number; app_cases: number; app_edited: number; episodes: number; run_at: string; filter: string | null; tag: string | null };

/** Score every selection method on the cases, plus the model start picker when a model is given, and write the scorecard. */
export async function runSelectionEval(opts: SelectionEvalOptions = {}): Promise<{ stamp: string; meta: SelectionEvalMeta }> {
  const EVAL_DIR = selectionDir();
  await mkdir(join(EVAL_DIR, "results"), { recursive: true });
  const values = { filter: opts.filter, tag: opts.tag, limit: opts.limit === undefined ? undefined : String(opts.limit), concurrency: String(opts.concurrency ?? 4), "model-timeout-ms": String(opts.modelTimeoutMs ?? 90_000) };
  const casesDir = opts.casesDir ?? "cases";
  // A server with no Readwise export has no case files, and scores its own snips alone.
  const caseFiles = existsSync(join(EVAL_DIR, casesDir)) ? (await readdir(join(EVAL_DIR, casesDir))).filter((f) => f.endsWith(".json") && f !== "index.json") : [];
  const wanted = (c: SnipCase) => (!values.filter || c.id.includes(values.filter)) && (!values.tag || c.tags.includes(values.tag));
  const cases: SnipCase[] = [];
  for (const f of caseFiles) {
    const c = JSON.parse(await readFile(join(EVAL_DIR, casesDir, f), "utf8")) as SnipCase;
    if (!c.tags.some((t) => t.startsWith("source:"))) c.tags.push("source:readwise");
    if (wanted(c)) cases.push(c);
  }
  cases.push(...(opts.app?.cases ?? []).filter(wanted));
  cases.sort((a, b) => a.id.localeCompare(b.id));
  if (values.limit) cases.splice(Number(values.limit));
  if (cases.length === 0) throw new Error("no selection cases: none of the app's snips qualify, and there are no case files (eval:snips:build makes them from a Readwise export)");
  const transcripts = new Map<string, { t: NormalizedTranscript; duration_ms: number }>(opts.app?.transcripts ?? []);
  for (const c of cases) {
    if (transcripts.has(c.transcript_fixture)) continue;
    const api = JSON.parse(await readFile(join(EVAL_DIR, c.transcript_fixture), "utf8")) as ApiTranscript & { duration_ms: number };
    transcripts.set(c.transcript_fixture, { t: fromApi(api), duration_ms: api.duration_ms });
  }

  const methods = METHODS.map((m) => m.name);
  const rows: Row[] = [];
  for (const c of cases) {
    const entry = transcripts.get(c.transcript_fixture)!;
    for (const m of METHODS) {
      const t0 = performance.now();
      const sel = await m.run(entry.t, c, entry.duration_ms);
      rows.push(score(c, m.name, sel, performance.now() - t0, !m.name.startsWith("fixed"), entry.t));
    }
  }

  let modelLabel: string | null = null;
  let promptVersion: string | null = null;
  if (opts.model) {
    modelLabel = opts.modelLabel ?? "snap-90+model";
    promptVersion = opts.version ?? readRegistry()["span-picker"].active;
    const cachePath = join(EVAL_DIR, "results", "model-picks.jsonl");
    // Picks made before prompt versions existed are v1's, cached without a version in the key; later versions add theirs.
    const cacheKey = `${SELECTOR_VERSION}|${modelLabel}${promptVersion === "v1" ? "" : `|${promptVersion}`}`;
    const cached = cachedPicker(makeSpanPicker(opts.model, { timeout_ms: Number(values["model-timeout-ms"]), version: promptVersion }), cachePath, cacheKey);
    methods.push(modelLabel);
    const started = Date.now();
    let done = 0;
    let used = 0;
    const modelRows: Row[] = new Array<Row>(cases.length);
    await pool(cases, Number(values.concurrency), async (c, i) => {
      const entry = transcripts.get(c.transcript_fixture)!;
      const t0 = performance.now();
      const sel = await selectSpan({ transcript: entry.t, anchor_ms: c.anchor_ms, heard_from_ms: c.heard_from_ms, duration_ms: entry.duration_ms, picker: cached.picker(c.id) });
      modelRows[i] = score(c, modelLabel!, sel, performance.now() - t0, true, entry.t);
      done++;
      if (sel.method === "model") used++;
      opts.onProgress?.(done, cases.length);
      if (done % 25 === 0 || done === cases.length) {
        console.error(`model: ${done}/${cases.length} cases, ${used} model picks accepted, ${cached.hits()} from cache, ${((Date.now() - started) / 1000).toFixed(0)} s elapsed`);
      }
    });
    rows.push(...modelRows);
  }
  const overall = Object.fromEntries(methods.map((m) => [m, summarize(rows.filter((r) => r.method === m))]));
  const tagGroups = [...new Set(cases.flatMap((c) => c.tags))].filter((t) => /^(source:|app:|words:|anchor:|ends-|year:)/.test(t)).sort();
  const byTag = Object.fromEntries(tagGroups.map((tag) => [tag, Object.fromEntries(methods.map((m) => [m, summarize(rows.filter((r) => r.method === m && r.tags.includes(tag)))]))]));

  const stamp = opts.stamp ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  await mkdir(join(EVAL_DIR, "results"), { recursive: true });
  const meta: SelectionEvalMeta = { selector: SELECTOR_VERSION, sentencizer: SENTENCIZER_VERSION, model: modelLabel, prompt_name: "span-picker", prompt: promptVersion, cases_dir: casesDir, cases: cases.length, snips: new Set(cases.map((c) => ("kind" in c.source ? c.source.snip_id : c.source.readwise_highlight_id))).size, app_cases: cases.filter(isAppCase).length, app_edited: cases.filter((c) => isAppCase(c) && c.source.edited).length, episodes: new Set(cases.map((c) => c.source.asset_id)).size, run_at: new Date().toISOString(), filter: values.filter ?? null, tag: values.tag ?? null };
  const tag = casesDir === "cases" ? "" : `-${casesDir}`;
  await writeFile(join(EVAL_DIR, "results", `${stamp}-selection${tag}.json`), JSON.stringify({ meta, overall, by_tag: byTag, rows }, null, 1));

  const header = "| Method | n | Start hit | End hit | Both (no edit) | Mean IoU | Median over-capture s | Median under-capture s | Median duration s | Fallback | Model used | Model rejected | Model failed | Violations | p95 latency ms |";
  const sep = "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |";
  const line = (m: string, s: ReturnType<typeof summarize>) => `| ${m} | ${s.n} | ${s.start_hit} | ${s.end_hit} | ${s.both} | ${s.mean_iou} | ${s.median_over_s} | ${s.median_under_s} | ${s.median_duration_s} | ${s.fallback} | ${s.model_used} | ${s.model_rejected} | ${s.model_failed} | ${s.violations} | ${s.p95_latency_ms.toFixed(0)} |`;
  const md: string[] = [
    `# Snip selection scorecard`,
    ``,
    `Run ${meta.run_at}. Selector \`${meta.selector}\`, sentencizer \`${meta.sentencizer}\`, cases from \`${meta.cases_dir}\`. ${meta.cases} cases from ${meta.snips} snips across ${meta.episodes} episodes: ${meta.cases - meta.app_cases} simulated taps on Readwise snips, and ${meta.app_cases} snips made in the app (${meta.app_edited} with boundaries the owner moved)${meta.tag ? `, tag \`${meta.tag}\`` : ""}${meta.filter ? `, filter \`${meta.filter}\`` : ""}.`,
    ``,
    `A hit means the chosen boundary falls inside the acceptable range (one sentence of slack around the labelled boundary). IoU is against the labelled span in milliseconds. Over-capture is audio included before the ideal start; under-capture is ideal audio left out.`,
    ``,
    `The label of a Readwise case is the Snipd snip's words aligned to the transcript. The label of a snip made in the app is the span the owner left it with: exact where the owner moved a boundary (\`app:edited\`, with \`app:start-earlier\`, \`app:start-later\` and \`app:end-moved\` saying which), and weaker where it was left alone (\`app:left-alone\`), since nothing says the snip was looked at. A method that fixes edited snips while leaving the others as they were is the one to want.`,
    ``,
    `## Overall`,
    ``,
    header,
    sep,
    ...methods.map((m) => line(m, overall[m]!)),
    ``,
    `## "Both" rate by group`,
    ``,
    `| Group | n | ${methods.join(" | ")} |`,
    `| --- | ---: | ${methods.map(() => "---:").join(" | ")} |`,
    ...tagGroups.map((tag) => `| ${tag} | ${byTag[tag]![methods[0]!]!.n} | ${methods.map((m) => byTag[tag]![m]!.both).join(" | ")} |`),
    ``,
    `## Mean IoU by group`,
    ``,
    `| Group | ${methods.join(" | ")} |`,
    `| --- | ${methods.map(() => "---:").join(" | ")} |`,
    ...tagGroups.map((tag) => `| ${tag} | ${methods.map((m) => byTag[tag]![m]!.mean_iou).join(" | ")} |`),
    ``,
  ];
  await writeFile(join(EVAL_DIR, "results", `${stamp}-selection${tag}.md`), md.join("\n"));
  return { stamp, meta };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      filter: { type: "string" },
      tag: { type: "string" },
      limit: { type: "string" },
      model: { type: "boolean", default: false },
      version: { type: "string" },
      concurrency: { type: "string", default: "4" },
      "model-timeout-ms": { type: "string", default: "90000" },
      "cases-dir": { type: "string", default: "cases" },
      app: { type: "boolean", default: false },
    },
  });
  // The app's snips are read from the database the server's configuration names (DATA_DIR); nothing is written to it.
  const ctx = values.app ? createContext(loadConfig()) : null;
  const codex = `codex${process.env.CODEX_MODEL ? `:${process.env.CODEX_MODEL}` : ""}${process.env.CODEX_REASONING_EFFORT ? `/${process.env.CODEX_REASONING_EFFORT}` : ""}`;
  const { stamp } = await runSelectionEval({
    casesDir: values["cases-dir"]!,
    ...(ctx ? { app: appSnipCases(ctx) } : {}),
    ...(values.filter ? { filter: values.filter } : {}),
    ...(values.tag ? { tag: values.tag } : {}),
    ...(values.limit ? { limit: Number(values.limit) } : {}),
    ...(values.model ? { model: new CodexCliTextModel({ model: process.env.CODEX_MODEL ?? "", reasoningEffort: process.env.CODEX_REASONING_EFFORT ?? "" }), modelLabel: `snap-90+model (${codex})` } : {}),
    ...(values.version ? { version: values.version } : {}),
    concurrency: Number(values.concurrency),
    modelTimeoutMs: Number(values["model-timeout-ms"]),
  });
  const tag = values["cases-dir"] === "cases" ? "" : `-${values["cases-dir"]}`;
  console.log(await readFile(join(selectionDir(), "results", `${stamp}-selection${tag}.md`), "utf8"));
  console.log(`wrote ${join(selectionDir(), "results", `${stamp}-selection${tag}.{json,md}`)}`);
  ctx?.db.close();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });
}
