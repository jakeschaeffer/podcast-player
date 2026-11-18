import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CodexCliTextModel } from "../adapters/codex-cli.js";
import { ElevenLabsTranscriber } from "../adapters/elevenlabs.js";
import { ElevenLabsForcedAligner, type ForcedAligner } from "../adapters/forcedAlignment.js";
import type { TextModel } from "../adapters/textModel.js";
import type { Transcriber } from "../adapters/transcriber.js";
import { ReadwiseApi, type Readwise } from "../adapters/readwise.js";
import { ExaPodcastSearch, type PodcastSearch } from "../adapters/exa.js";
import { showSearchFromEnv, type ShowSearch } from "../adapters/showSearch.js";
import { openDb, type Db } from "../db/index.js";
import { JobQueue } from "../jobs/queue.js";
import type { Config } from "../lib/config.js";
import { Secrets } from "../lib/crypto.js";

export type Paths = { data: string; db: string; media: string; assets: string; clips: string; tmp: string };

/** Everything a service or job handler needs. Built once per process; tests build one around an in-memory database. */
export type AppContext = {
  config: Config;
  db: Db;
  secrets: Secrets;
  queue: JobQueue;
  paths: Paths;
  transcriber: Transcriber | null;
  aligner: ForcedAligner | null;
  textModel: TextModel | null;
  /** The text model for the snip calls (episode map, span picker, snip summary): the same Codex with the snip
   * settings (CODEX_SNIP_*). Null exactly when textModel is. */
  snipTextModel: TextModel | null;
  /** Finds public shows to subscribe to (iTunes Search, or Podcast Index when its keys are set). */
  showSearch: ShowSearch;
  /** The owner's Readwise, when READWISE_TOKEN is set; every snip goes there as a highlight. */
  readwise: Readwise | null;
  /** Exa's podcast search, when EXA_API_KEY is set: topic search for episodes, including shows not followed. */
  podcastSearch: PodcastSearch | null;
  now: () => number;
  log: (msg: string, extra?: Record<string, unknown>) => void;
};

export type ContextOverrides = Partial<Pick<AppContext, "transcriber" | "aligner" | "textModel" | "snipTextModel" | "showSearch" | "readwise" | "podcastSearch" | "now" | "log">> & { dbPath?: string };

export function createContext(config: Config, overrides: ContextOverrides = {}): AppContext {
  const paths = pathsFor(config.dataDir);
  for (const dir of [paths.data, paths.media, paths.assets, paths.clips, paths.tmp]) mkdirSync(dir, { recursive: true });
  const db = openDb(overrides.dbPath ?? paths.db);
  const transcriber =
    overrides.transcriber !== undefined
      ? overrides.transcriber
      : config.elevenLabsApiKey
        ? new ElevenLabsTranscriber({ apiKey: config.elevenLabsApiKey, centsPerHour: config.transcriptionCentsPerHour })
        : null;
  const aligner =
    overrides.aligner !== undefined
      ? overrides.aligner
      : config.elevenLabsApiKey
        ? new ElevenLabsForcedAligner({ apiKey: config.elevenLabsApiKey, centsPerHour: config.transcriptionCentsPerHour })
        : null;
  const textModel =
    overrides.textModel !== undefined ? overrides.textModel : config.textModel === "codex-cli" ? new CodexCliTextModel({ model: config.codexModel, reasoningEffort: config.codexReasoningEffort, serviceTier: config.codexServiceTier }) : null;
  const snipTextModel =
    overrides.snipTextModel !== undefined
      ? overrides.snipTextModel
      : overrides.textModel !== undefined
        ? overrides.textModel
        : config.textModel === "codex-cli"
          ? new CodexCliTextModel({ model: config.codexModel, reasoningEffort: config.snipCodexReasoningEffort, serviceTier: config.snipCodexServiceTier })
          : null;
  const now = overrides.now ?? Date.now;
  return {
    config,
    db,
    secrets: new Secrets(config.appSecret),
    queue: new JobQueue(db, now),
    paths,
    transcriber,
    aligner,
    textModel,
    snipTextModel,
    showSearch: overrides.showSearch ?? showSearchFromEnv(),
    readwise: overrides.readwise !== undefined ? overrides.readwise : config.readwiseToken ? new ReadwiseApi({ token: config.readwiseToken }) : null,
    podcastSearch: overrides.podcastSearch !== undefined ? overrides.podcastSearch : config.exaApiKey ? new ExaPodcastSearch({ apiKey: config.exaApiKey, effort: config.exaEffort }) : null,
    now,
    log: overrides.log ?? ((msg, extra) => console.error(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }))),
  };
}

export function pathsFor(dataDir: string): Paths {
  const media = join(dataDir, "media");
  return { data: dataDir, db: join(dataDir, "app.db"), media, assets: join(media, "assets"), clips: join(media, "clips"), tmp: join(media, "tmp") };
}
