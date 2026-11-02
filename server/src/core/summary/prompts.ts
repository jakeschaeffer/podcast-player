import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The prompts the app runs. Each has a folder of versions under prompts/ (see prompts/README.md). */
export const PROMPT_NAMES = ["snip-summary", "episode-summary", "span-picker", "speakers", "title-judge"] as const;
export type PromptName = (typeof PROMPT_NAMES)[number];

export type PromptVersionEntry = { created_at: string; sha256: string };
export type PromptRegistry = Record<PromptName, { active: string; versions: Record<string, PromptVersionEntry> }>;

const DEFAULT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../prompts");

/** server/prompts, or PROMPTS_DIR when tests or local tools point at a copy. */
export function promptsDir(): string {
  return process.env.PROMPTS_DIR || DEFAULT_DIR;
}

export function isPromptName(name: string): name is PromptName {
  return (PROMPT_NAMES as readonly string[]).includes(name);
}

/** prompts/registry.json: the active version of each prompt, and each version's creation time and content hash. */
export function readRegistry(): PromptRegistry {
  return JSON.parse(readFileSync(join(promptsDir(), "registry.json"), "utf8")) as PromptRegistry;
}

/** Load `prompts/<name>/<version>.md`. Version names are `v` and a number, so no request can reach outside the folder. */
export function loadPrompt(name: PromptName, version: string): string {
  if (!/^v\d{1,4}$/.test(version)) throw new Error(`not a prompt version: ${version}`);
  return readFileSync(join(promptsDir(), name, `${version}.md`), "utf8").trim();
}

/**
 * The instructions to send and the version to record with the output: the version asked for, or else the active one.
 * Read on every call, so activating a version reaches the next model call without a restart.
 */
export function resolvePrompt(name: PromptName, version?: string): { version: string; text: string } {
  const v = version ?? readRegistry()[name].active;
  return { version: v, text: loadPrompt(name, v) };
}
