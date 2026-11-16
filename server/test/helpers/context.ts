import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, type AppContext } from "../../src/app/context.js";
import type { TextModel } from "../../src/adapters/textModel.js";
import type { Transcriber } from "../../src/adapters/transcriber.js";
import type { ShowResult, ShowSearch } from "../../src/adapters/showSearch.js";
import type { ForcedAligner } from "../../src/adapters/forcedAlignment.js";
import type { Readwise } from "../../src/adapters/readwise.js";
import type { FoundEpisode, PodcastSearch, PodcastSearchRun } from "../../src/adapters/exa.js";
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
    videoMaxHeight: 480,
    timezone: "UTC",
    elevenLabsApiKey: null,
    transcriptionCentsPerHour: 22,
    textModel: "none",
    codexModel: "",
    codexReasoningEffort: "",
    snipCodexReasoningEffort: "",
    snipCodexServiceTier: "",
    selectionModel: false,
    // Off unless a test is about maps: with a fake text model on, every snip would otherwise queue one.
    episodeMaps: false,
    emailSourceQuery: "",
    textPreferredKinds: new Set(["update", "article"]),
    mediaUrlTtlSeconds: 3600,
    transcriptionBudgetMinutes: 6000,
    allowPrivateNetwork: true,
    refreshIntervalMinutes: 0,
    gitAutoPush: false,
    readwiseToken: null,
    exaApiKey: null,
    exaEffort: "low",
    ...overrides,
  };
}

export function testContext(opts: { transcriber?: Transcriber | null; aligner?: ForcedAligner | null; textModel?: TextModel | null; showSearch?: ShowSearch; readwise?: Readwise | null; podcastSearch?: PodcastSearch | null; config?: Partial<Config>; now?: () => number } = {}): AppContext {
  const logs: unknown[] = [];
  return createContext(testConfig(opts.config), {
    transcriber: opts.transcriber ?? null,
    aligner: opts.aligner ?? null,
    textModel: opts.textModel ?? null,
    // Tests never reach a real directory: an unconfigured search answers with nothing.
    showSearch: opts.showSearch ?? new FixedShowSearch([]),
    // Nothing reaches the owner's Readwise from a test.
    readwise: opts.readwise ?? null,
    // Nothing reaches Exa from a test: topic search is off unless a test hands in a fake.
    podcastSearch: opts.podcastSearch ?? null,
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

/**
 * Exa's podcast search as a script: `start` hands out run ids, and each run answers `running` for `pending` checks,
 * then whatever `finish` set for it (completed with `episodes` by default). Remembers every call; never bills.
 */
export class FakePodcastSearch implements PodcastSearch {
  readonly name = "fake";
  starts: string[] = [];
  checks: string[] = [];
  pending = 1;
  private runs = new Map<string, { left: number; outcome: PodcastSearchRun }>();
  constructor(public episodes: FoundEpisode[] = []) {}
  async start(topic: string): Promise<{ run_id: string }> {
    this.starts.push(topic);
    const run_id = `agent_run_fake${this.starts.length}`;
    this.runs.set(run_id, { left: this.pending, outcome: { status: "completed", episodes: this.episodes, cost_dollars: 0.04, podcast_index_calls: 2 } });
    return { run_id };
  }
  finish(runId: string, outcome: PodcastSearchRun): void {
    const run = this.runs.get(runId);
    if (run) run.outcome = outcome;
  }
  async check(runId: string): Promise<PodcastSearchRun> {
    this.checks.push(runId);
    const run = this.runs.get(runId);
    if (!run) return { status: "failed", error: "no such run" };
    if (run.left > 0) {
      run.left -= 1;
      return { status: "running" };
    }
    return run.outcome;
  }
}
