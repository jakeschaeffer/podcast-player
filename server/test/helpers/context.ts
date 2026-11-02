import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, type AppContext } from "../../src/app/context.js";
import type { TextModel } from "../../src/adapters/textModel.js";
import type { Transcriber } from "../../src/adapters/transcriber.js";
import type { ShowResult, ShowSearch } from "../../src/adapters/showSearch.js";
import type { ForcedAligner } from "../../src/adapters/forcedAlignment.js";
import type { Config } from "../../src/lib/config.js";

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    dataDir: mkdtempSync(join(tmpdir(), "pp-test-")),
    host: "127.0.0.1",
    port: 0,
    appSecret: "test-secret-test-secret-test-secret",
    ownerPassword: "hunter2",
    publicBaseUrl: "http://pods.test",
    shareByName: "Jake",
    videoStoreMaxBytes: 4 * 1024 ** 3,
    timezone: "UTC",
    elevenLabsApiKey: null,
    transcriptionCentsPerHour: 22,
    textModel: "none",
    codexModel: "",
    codexReasoningEffort: "",
    selectionModel: false,
    emailSourceQuery: "",
    textPreferredKinds: new Set(["update", "article"]),
    mediaUrlTtlSeconds: 3600,
    transcriptionBudgetMinutes: 6000,
    allowPrivateNetwork: true,
    refreshIntervalMinutes: 0,
    gitAutoPush: false,
    ...overrides,
  };
}

export function testContext(opts: { transcriber?: Transcriber | null; aligner?: ForcedAligner | null; textModel?: TextModel | null; showSearch?: ShowSearch; config?: Partial<Config>; now?: () => number } = {}): AppContext {
  const logs: unknown[] = [];
  return createContext(testConfig(opts.config), {
    transcriber: opts.transcriber ?? null,
    aligner: opts.aligner ?? null,
    textModel: opts.textModel ?? null,
    // Tests never reach a real directory: an unconfigured search answers with nothing.
    showSearch: opts.showSearch ?? new FixedShowSearch([]),
    ...(opts.now ? { now: opts.now } : {}),
    log: (msg, extra) => logs.push({ msg, ...extra }),
  });
}

/** A show search that answers every query with the same results, and remembers the queries. */
export class FixedShowSearch implements ShowSearch {
  readonly name = "fixed";
  queries: string[] = [];
  constructor(private readonly results: ShowResult[]) {}
  async search(query: string, limit = 10): Promise<ShowResult[]> {
    this.queries.push(query);
    return this.results.slice(0, limit);
  }
}
