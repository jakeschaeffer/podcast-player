/**
 * Topic search over podcast transcripts: Exa's Agent API (https://exa.ai/docs/agent/quickstart) with Particle's
 * podcast index attached through Exa Connect (`dataSources: [{ provider: "particle" }]`,
 * https://exa.ai/docs/agent/connect/particle). A run is asynchronous: `start` creates it and returns at once,
 * `check` reads where it stands. Only creating a run bills (the effort's fixed price, plus $0.015 a Particle call);
 * reading one does not.
 */
import { NonRetryable } from "../jobs/errors.js";

/** One episode the run found, as the output schema below asks for it. Any field may be missing or null. */
export type FoundEpisode = {
  podcast: string;
  episode: string;
  published: string | null;
  url: string | null;
  speaker: string | null;
  quote: string | null;
  why: string | null;
  start_seconds: number | null;
};

export type PodcastSearchRun =
  | { status: "running" }
  | { status: "completed"; episodes: FoundEpisode[]; cost_dollars: number | null }
  | { status: "failed"; error: string };

export interface PodcastSearch {
  readonly name: string;
  /** Starts a search for episodes about `topic`; returns the run's id. Bills. */
  start(topic: string): Promise<{ run_id: string }>;
  /** Where the run stands. Free. */
  check(runId: string): Promise<PodcastSearchRun>;
}

/** Fixed efforts bill a flat price a run; `auto` and `ultra` are metered and need a budget, so they are not offered. */
export type ExaEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export const EXA_EFFORTS: readonly ExaEffort[] = ["minimal", "low", "medium", "high", "xhigh"];

/** At most this many episodes a search: a bounded list keeps the run's cost and the screen's length predictable. */
export const MAX_EPISODES = 8;

const BASE = "https://api.exa.ai";

/** The run's output, `output.structured`. "from Particle" steers the agent to the podcast tool, as Exa's examples do. */
export const OUTPUT_SCHEMA = {
  type: "object",
  required: ["episodes"],
  properties: {
    episodes: {
      type: "array",
      maxItems: MAX_EPISODES,
      items: {
        type: "object",
        required: ["podcast", "episode"],
        properties: {
          podcast: { type: "string", description: "The show's name as its feed gives it, from Particle" },
          episode: { type: "string", description: "The episode's title as published, from Particle" },
          published: { type: "string", description: "The episode's release date, YYYY-MM-DD" },
          url: { type: "string", format: "uri", description: "A page or video link for this episode, when known" },
          speaker: { type: "string", description: "Who talks about the topic" },
          quote: { type: "string", description: "A short line they said about it, word for word from the transcript" },
          why: { type: "string", description: "One plain sentence: what the episode says about the topic" },
          start_seconds: { type: "number", description: "Seconds from the start of the episode where the topic comes up" },
        },
      },
    },
  },
} as const;

const SYSTEM_PROMPT =
  "Use the Particle podcast transcripts to find episodes. One entry per episode; never list the same episode twice. " +
  "Keep an episode only when the topic is discussed in it, not just mentioned in passing. Give the show's name and the " +
  "episode's title exactly as published, never paraphrased. Leave a field out when the sources do not support it.";

export function topicQuery(topic: string): string {
  return `Find podcast episodes that discuss ${topic}, from Particle's podcast transcripts.`;
}

export class ExaPodcastSearch implements PodcastSearch {
  readonly name = "exa";
  constructor(private readonly opts: { apiKey: string; effort: ExaEffort; fetch?: typeof fetch; base?: string }) {}

  async start(topic: string): Promise<{ run_id: string }> {
    const body = {
      query: topicQuery(topic),
      systemPrompt: SYSTEM_PROMPT,
      effort: this.opts.effort,
      dataSources: [{ provider: "particle" }],
      outputSchema: OUTPUT_SCHEMA,
    };
    const run = (await (await this.call("POST", "/agent/runs", body)).json()) as { id?: unknown };
    if (typeof run.id !== "string" || !run.id) throw new Error("Exa created a run without an id");
    return { run_id: run.id };
  }

  async check(runId: string): Promise<PodcastSearchRun> {
    const run = (await (await this.call("GET", `/agent/runs/${encodeURIComponent(runId)}`)).json()) as ExaRun;
    return readRun(run);
  }

  /** A refused key or a rejected request will not pass on a retry; a rate limit, a 5xx or the network may. */
  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await (this.opts.fetch ?? fetch)(`${this.opts.base ?? BASE}${path}`, {
      method,
      headers: { "x-api-key": this.opts.apiKey, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) return res;
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    const message = `Exa ${method} ${path.split("/").slice(0, 3).join("/")} answered ${res.status}${detail ? `: ${detail}` : ""}`;
    if (res.status === 401 || res.status === 403) throw new NonRetryable(`${message} (check EXA_API_KEY)`);
    if (res.status === 429 || res.status >= 500) throw new Error(message);
    throw new NonRetryable(message);
  }
}

/** The fields of an Agent run this adapter reads (the full shape is AgentRun in https://exa.ai/docs/exa-spec.yaml). */
export type ExaRun = {
  id?: string;
  status?: string;
  error?: { message?: string; code?: string } | null;
  output?: { structured?: unknown } | null;
  costDollars?: { total?: number } | null;
};

/** Only `completed` carries results; `failed` and `cancelled` end the run without them. */
export function readRun(run: ExaRun): PodcastSearchRun {
  if (run.status === "completed") {
    return { status: "completed", episodes: foundEpisodes(run.output?.structured), cost_dollars: typeof run.costDollars?.total === "number" ? run.costDollars.total : null };
  }
  if (run.status === "failed") return { status: "failed", error: run.error?.message || run.error?.code || "the search failed" };
  if (run.status === "cancelled") return { status: "failed", error: "the search was cancelled" };
  return { status: "running" };
}

/** Validates the structured output loosely: a model filled it, so anything may be missing, null or the wrong type. */
export function foundEpisodes(structured: unknown): FoundEpisode[] {
  const list = (structured as { episodes?: unknown } | null)?.episodes;
  if (!Array.isArray(list)) return [];
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const out: FoundEpisode[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const podcast = str(r.podcast);
    const episode = str(r.episode);
    if (!podcast || !episode) continue;
    const start = typeof r.start_seconds === "number" && Number.isFinite(r.start_seconds) && r.start_seconds >= 0 ? Math.round(r.start_seconds) : null;
    const url = str(r.url);
    out.push({ podcast, episode, published: str(r.published), url: url && /^https?:\/\//i.test(url) ? url : null, speaker: str(r.speaker), quote: str(r.quote), why: str(r.why), start_seconds: start });
    if (out.length >= MAX_EPISODES) break;
  }
  return out;
}
