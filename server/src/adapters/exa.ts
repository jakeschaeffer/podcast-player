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
  | { status: "completed"; episodes: FoundEpisode[]; cost_dollars: number | null; podcast_index_calls: number | null }
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
export const MAX_EPISODES = 5;

const BASE = "https://api.exa.ai";

/**
 * The run's output, `output.structured`. Attaching Particle does not make the agent call it (Exa's "Combining
 * providers" guide): it calls a partner when the query and the schema ask for data only that partner has. So the
 * speaker, their words and the timestamp, which only a transcript gives, are required of every episode.
 */
export const OUTPUT_SCHEMA = {
  type: "object",
  required: ["episodes"],
  properties: {
    episodes: {
      type: "array",
      maxItems: MAX_EPISODES,
      items: {
        type: "object",
        required: ["podcast", "episode", "speaker", "quote", "timestamp"],
        properties: {
          podcast: { type: "string", description: "The show's name, from Particle's podcast transcripts" },
          episode: { type: "string", description: "The episode's title, from Particle's podcast transcripts" },
          published: { type: "string", description: "The episode's release date, YYYY-MM-DD" },
          url: { type: "string", format: "uri", description: "The episode's own page or video link, when known" },
          speaker: { type: "string", description: "Who says it, from Particle's speaker-attributed transcript" },
          quote: { type: "string", description: "What they say about the topic, word for word from Particle's transcript" },
          why: { type: "string", description: "One plain sentence: what the episode says about the topic" },
          // Text, as transcripts print it: asked for as a number of seconds, every one came back null.
          timestamp: { type: "string", description: "Where in the episode they say it, as H:MM:SS or M:SS, from Particle's transcript timestamps" },
        },
      },
    },
  },
} as const;

// Each Particle call bills $0.015, and searching again for each episode cost nine calls for five episodes; a
// search or two with the topic itself returns transcript windows from many episodes at once.
export const SYSTEM_PROMPT =
  "Search the Particle podcast transcript tool once or twice with the topic itself, and choose the episodes from " +
  "those results; do not search again for each episode. Take each episode's speaker, quote and timestamp from its " +
  "transcript results. Use web search only to find an episode's own page link, never as the source of an episode. " +
  "One entry per episode; never list the same episode twice. Keep an episode only when the topic is discussed in it, " +
  "not just mentioned in passing. Give the show's name and the episode's title exactly as published.";

export function topicQuery(topic: string): string {
  return `Search podcast transcripts for episodes where hosts or guests discuss ${topic}. For each episode give the show, the episode title, who is speaking, their words quoted from the transcript, and the timestamp where they say it.`;
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
  /** Per-provider Exa Connect call counts; only providers the run called appear. */
  usage?: { dataSources?: Record<string, number> } | null;
};

/** Only `completed` carries results; `failed` and `cancelled` end the run without them. */
export function readRun(run: ExaRun): PodcastSearchRun {
  if (run.status === "completed") {
    const calls = run.usage ? (run.usage.dataSources?.particle ?? 0) : null;
    return { status: "completed", episodes: foundEpisodes(run.output?.structured), cost_dollars: typeof run.costDollars?.total === "number" ? run.costDollars.total : null, podcast_index_calls: calls };
  }
  if (run.status === "failed") return { status: "failed", error: run.error?.message || run.error?.code || "the search failed" };
  if (run.status === "cancelled") return { status: "failed", error: "the search was cancelled" };
  return { status: "running" };
}

/** "1:02:03", "31:48", "31m48s", or a number of seconds; null for anything else. */
export function secondsIn(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
  if (typeof v !== "string") return null;
  const t = v.trim();
  const clock = t.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.\d+)?$/);
  if (clock) return Number(clock[1] ?? 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  const units = t.match(/^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?$/i);
  if (units && (units[1] || units[2] || units[3])) return Number(units[1] ?? 0) * 3600 + Number(units[2] ?? 0) * 60 + Number(units[3] ?? 0);
  return /^\d+(\.\d+)?$/.test(t) ? Math.round(Number(t)) : null;
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
    const start = secondsIn(r.timestamp ?? r.start_seconds);
    const url = str(r.url);
    out.push({ podcast, episode, published: str(r.published), url: url && /^https?:\/\//i.test(url) ? url : null, speaker: str(r.speaker), quote: str(r.quote), why: str(r.why), start_seconds: start });
    if (out.length >= MAX_EPISODES) break;
  }
  return out;
}
