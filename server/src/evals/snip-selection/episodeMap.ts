import { appendFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { EpisodeMap } from "../../core/snip/episodeMap.js";

/**
 * The selection eval's side of episode maps (core/snip/episodeMap.ts, services/episodeMaps.ts): a cache of maps
 * already made, by transcript, prompt version and model label, so rescoring a rule costs no model calls.
 */
export { mapPicker, PASSAGE_EPS_MS, PASSAGE_MIN_MS, type EpisodeMap, type MapRule } from "../../core/snip/episodeMap.js";
export { buildEpisodeMap } from "../../services/episodeMaps.js";

export async function readMapCache(path: string): Promise<Map<string, EpisodeMap>> {
  const out = new Map<string, EpisodeMap>();
  if (!existsSync(path)) return out;
  for (const line of (await readFile(path, "utf8")).split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as { key: string; map: EpisodeMap };
    out.set(row.key, row.map);
  }
  return out;
}

export async function writeMapCache(path: string, key: string, map: EpisodeMap, meta: Record<string, unknown>): Promise<void> {
  await appendFile(path, `${JSON.stringify({ key, ...meta, map })}\n`);
}
