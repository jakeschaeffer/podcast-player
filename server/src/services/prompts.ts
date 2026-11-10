import { createHash } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppContext } from "../app/context.js";
import { badRequest, conflict, notFound } from "../app/errors.js";
import { isPromptName, loadPrompt, PROMPT_NAMES, promptsDir, readRegistry, type PromptName, type PromptRegistry } from "../core/summary/prompts.js";
import { commitFiles } from "../lib/git.js";
import { evalForPrompt, latestScores, listRuns, type RunView, type Score } from "./evalRuns.js";
import { boundaryEditRates, titleRewriteRates, type EditRate } from "./snipEdits.js";

/**
 * The owner's view of prompts/: every version with its score, new versions, and which one is active. Versions are
 * files that are never edited; activating one changes registry.json, which the model calls read each time. Each
 * change is committed to the repository that holds the folder, so the history lives in git too.
 */
export const PROMPT_LABELS: Record<PromptName, string> = { "snip-summary": "Snip summary", "episode-summary": "Episode summary", "span-picker": "Snip start", speakers: "Speakers", "title-judge": "Title judge (evals)" };
/** What the owner's edit of a prompt's output is called, for the prompts whose output can be edited. */
const EDITS_LABELS: Partial<Record<PromptName, string>> = { "snip-summary": "titles rewritten", "span-picker": "spans moved" };
const MAX_CHARS = 20_000;

export type PromptVersionItem = { version: string; created_at: number; active: boolean; score: Score | null; edits: EditRate | null };
export type PromptView = { name: PromptName; label: string; active: string; in_use: boolean; eval: { id: string; label: string } | null; edits_label: string | null; rules_edits: EditRate | null; versions: PromptVersionItem[] };
export type PromptVersionView = { name: PromptName; label: string; version: string; text: string; created_at: number; active: boolean; previous: { version: string; text: string } | null; eval: { id: string; label: string } | null; runs: RunView[] };

export function promptName(name: string): PromptName {
  if (!isPromptName(name)) throw notFound("prompt");
  return name;
}

const num = (v: string) => Number(v.slice(1));

/** Whether production calls this prompt at all: summaries need a text model, the start picker also SELECTION_MODEL. */
function inUse(ctx: AppContext, name: PromptName): boolean {
  if (!ctx.textModel) return false;
  return name === "span-picker" ? ctx.config.selectionModel : true;
}

export function getPrompt(ctx: AppContext, name: PromptName, registry: PromptRegistry = readRegistry()): PromptView {
  const entry = registry[name];
  const ev = evalForPrompt(name);
  const scores = ev ? latestScores(ctx, ev.id) : new Map<string, Score>();
  // How the versions fared in use, beside how they scored: what the owner changed of what each wrote.
  const spans = name === "span-picker" ? boundaryEditRates(ctx) : null;
  const edits = spans ? spans.versions : name === "snip-summary" ? titleRewriteRates(ctx) : new Map<string, EditRate>();
  const versions = Object.entries(entry.versions)
    .sort(([a], [b]) => num(b) - num(a))
    .map(([version, v]) => ({ version, created_at: Date.parse(v.created_at), active: version === entry.active, score: scores.get(version) ?? null, edits: edits.get(version) ?? null }));
  return {
    name, label: PROMPT_LABELS[name], active: entry.active, in_use: inUse(ctx, name), eval: ev ? { id: ev.id, label: ev.label } : null,
    edits_label: EDITS_LABELS[name] ?? null, rules_edits: spans && spans.rules.snips > 0 ? spans.rules : null, versions,
  };
}

export function listPrompts(ctx: AppContext): PromptView[] {
  const registry = readRegistry();
  return PROMPT_NAMES.map((name) => getPrompt(ctx, name, registry));
}

export function getPromptVersion(ctx: AppContext, name: PromptName, version: string): PromptVersionView {
  const registry = readRegistry();
  const entry = registry[name].versions[version];
  if (!entry) throw notFound("prompt version");
  const earlier = Object.keys(registry[name].versions).filter((v) => num(v) < num(version)).sort((a, b) => num(b) - num(a))[0];
  const ev = evalForPrompt(name);
  return {
    name,
    label: PROMPT_LABELS[name],
    version,
    text: loadPrompt(name, version),
    created_at: Date.parse(entry.created_at),
    active: registry[name].active === version,
    previous: earlier ? { version: earlier, text: loadPrompt(name, earlier) } : null,
    eval: ev ? { id: ev.id, label: ev.label } : null,
    runs: ev ? listRuns(ctx, ev.id).filter((r) => r.version === version) : [],
  };
}

// One registry change at a time: each reads the file, writes it whole, and commits.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

function writeRegistry(registry: PromptRegistry): string {
  const path = join(promptsDir(), "registry.json");
  writeFileSync(`${path}.tmp`, `${JSON.stringify(registry, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
  return path;
}

/** Save text as the next version. It is not active until activated. */
export function createPromptVersion(ctx: AppContext, name: PromptName, text: string): Promise<PromptVersionView> {
  return serial(async () => {
    const body = text.replace(/\r\n/g, "\n").trim();
    if (!body) throw badRequest("the prompt is empty");
    if (body.length > MAX_CHARS) throw badRequest(`the prompt is longer than ${MAX_CHARS} characters`);
    const registry = readRegistry();
    const versions = Object.keys(registry[name].versions);
    const same = versions.find((v) => loadPrompt(name, v) === body);
    if (same) throw conflict(`same text as ${same}`);
    const version = `v${Math.max(0, ...versions.map(num)) + 1}`;
    const file = join(promptsDir(), name, `${version}.md`);
    const content = `${body}\n`;
    writeFileSync(file, content, { flag: "wx" });
    registry[name].versions[version] = { created_at: new Date(ctx.now()).toISOString(), sha256: createHash("sha256").update(content).digest("hex") };
    const reg = writeRegistry(registry);
    ctx.log("prompt version created", { prompt: name, version });
    await commitFiles([file, reg], `Prompts: add ${name} ${version}`, ctx.log, { push: ctx.config.gitAutoPush });
    return getPromptVersion(ctx, name, version);
  });
}

/** Make a version the one production uses from the next model call on. */
export function activatePromptVersion(ctx: AppContext, name: PromptName, version: string): Promise<PromptView> {
  return serial(async () => {
    const registry = readRegistry();
    if (!registry[name].versions[version]) throw notFound("prompt version");
    if (registry[name].active !== version) {
      const from = registry[name].active;
      registry[name].active = version;
      const reg = writeRegistry(registry);
      ctx.log("prompt version activated", { prompt: name, from, to: version });
      await commitFiles([reg], `Prompts: activate ${name} ${version}`, ctx.log, { push: ctx.config.gitAutoPush });
    }
    return getPrompt(ctx, name);
  });
}
