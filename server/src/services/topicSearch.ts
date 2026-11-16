/**
 * Topic search: "find episodes about X", over podcast transcripts through Exa (adapters/exa.ts), including shows the
 * owner does not follow. A search is an asynchronous Exa run: POST starts it (that bills), GET reads it, asking Exa
 * how the run stands at most every few seconds while it runs (free). Each episode found is matched to ours where it
 * can be: an episode we have (by its page link, its YouTube video, or its title within the show), else a show we
 * have, else a show from the directory to open, else a YouTube video to add. Matching happens on every read, so a show the owner adds afterwards turns its rows into episodes.
 */
import type { AppContext } from "../app/context.js";
import { HttpError, badRequest, conflict, notFound } from "../app/errors.js";
import type { FoundEpisode } from "../adapters/exa.js";
import type { ShowResult } from "../adapters/showSearch.js";
import { youtubeIdFrom } from "../core/feed/youtube.js";
import type { EpisodeRow, FeedRow } from "../db/rows.js";
import { newId } from "../lib/ids.js";
import { episodeListItem, type EpisodeListItem } from "./episodes.js";
import { findEpisodeByTitle, normalizeTitle, titleSimilarity } from "./titleMatch.js";

/** The same query again within this long gets the earlier search back instead of a new, billed run. */
export const REUSE_MS = 24 * 3600_000;
/** How often a read may ask Exa about a running search. */
export const CHECK_EVERY_MS = 3_000;
/** A run still going after this long is given up on. */
export const GIVE_UP_MS = 15 * 60_000;

type TopicSearchRow = {
  id: string; query: string; query_key: string; client_request_id: string | null; run_id: string;
  status: "running" | "completed" | "failed"; episodes: string | null; shows: string | null; error: string | null;
  cost_dollars: number | null; podcast_index_calls: number | null; checked_at: number | null; created_at: number; completed_at: number | null;
};

/**
 * episode: one of ours (play it); show: a show we have, without this episode in it (open the show);
 * new_show: a show from the directory (open it without following, POST /v1/feeds with followed false);
 * video: a YouTube video (add it, POST /v1/links/episodes); none: nothing to open.
 */
export type TopicMatch = "episode" | "show" | "new_show" | "video" | "none";

export type TopicResult = {
  podcast: string;
  title: string;
  published: string | null;
  url: string | null;
  speaker: string | null;
  quote: string | null;
  why: string | null;
  start_ms: number | null;
  match: TopicMatch;
  episode: EpisodeListItem | null;
  feed_id: string | null;
  followed: boolean | null;
  show: { title: string; author: string | null; feed_url: string; artwork_url: string | null } | null;
  youtube_id: string | null;
};

export type TopicSearchView = {
  id: string;
  query: string;
  status: "running" | "completed" | "failed";
  error: string | null;
  results: TopicResult[];
  cost_dollars: number | null;
  podcast_index_calls: number | null;
  created_at: number;
  completed_at: number | null;
};

export type StartTopicSearchInput = { query: string; client_request_id?: string };

export function topicSearchEnabled(ctx: AppContext): boolean {
  return ctx.podcastSearch !== null;
}

const queryKey = (q: string) => q.toLowerCase().replace(/\s+/g, " ").trim();

/** Starts a search, unless this request or the same query (running, or done within a day) already has one. */
export async function startTopicSearch(ctx: AppContext, input: StartTopicSearchInput): Promise<{ search: TopicSearchView; created: boolean }> {
  const search = ctx.podcastSearch;
  if (!search) throw conflict("topic search is off: the server has no EXA_API_KEY");
  const query = input.query.replace(/\s+/g, " ").trim();
  if (query.length < 2) throw badRequest("query must be at least 2 characters");
  if (input.client_request_id) {
    const same = ctx.db.prepare("SELECT * FROM topic_search WHERE client_request_id = ?").get(input.client_request_id) as TopicSearchRow | undefined;
    if (same) return { search: view(ctx, same), created: false };
  }
  const key = queryKey(query);
  const recent = ctx.db
    .prepare("SELECT * FROM topic_search WHERE query_key = ? AND status != 'failed' AND created_at >= ? ORDER BY created_at DESC LIMIT 1")
    .get(key, ctx.now() - REUSE_MS) as TopicSearchRow | undefined;
  if (recent) return { search: view(ctx, recent), created: false };

  let runId: string;
  try {
    ({ run_id: runId } = await search.start(query));
  } catch (err) {
    ctx.log("topic search: start failed", { source: search.name, error: String(err) });
    throw new HttpError(502, `topic search is unavailable right now (${search.name})`, "upstream");
  }
  const id = newId();
  const now = ctx.now();
  ctx.db
    .prepare("INSERT INTO topic_search (id, query, query_key, client_request_id, run_id, status, checked_at, created_at) VALUES (?, ?, ?, ?, ?, 'running', ?, ?)")
    .run(id, query, key, input.client_request_id ?? null, runId, now, now);
  ctx.log("topic search: started", { id, run_id: runId });
  return { search: view(ctx, getRow(ctx, id)), created: true };
}

/** One search; a running one is first brought up to date with Exa (at most every CHECK_EVERY_MS). */
export async function getTopicSearch(ctx: AppContext, id: string): Promise<TopicSearchView> {
  let row = getRow(ctx, id);
  if (row.status === "running" && ctx.now() - (row.checked_at ?? 0) >= CHECK_EVERY_MS) {
    await advance(ctx, row);
    row = getRow(ctx, id);
  }
  return view(ctx, row);
}

/** The newest searches first, as stored (a list never asks Exa). */
export function listTopicSearches(ctx: AppContext, limit = 20): TopicSearchView[] {
  const rows = ctx.db.prepare("SELECT * FROM topic_search ORDER BY created_at DESC, id DESC LIMIT ?").all(Math.min(100, Math.max(1, limit))) as TopicSearchRow[];
  return rows.map((r) => view(ctx, r));
}

function getRow(ctx: AppContext, id: string): TopicSearchRow {
  const row = ctx.db.prepare("SELECT * FROM topic_search WHERE id = ?").get(id) as TopicSearchRow | undefined;
  if (!row) throw notFound("topic search");
  return row;
}

/** Two reads at once share one check, so a finished run's directory lookups happen once. */
const advancing = new Map<string, Promise<void>>();

function advance(ctx: AppContext, row: TopicSearchRow): Promise<void> {
  const key = `${ctx.paths.db}:${row.id}`;
  const busy = advancing.get(key);
  if (busy) return busy;
  const p = advanceOnce(ctx, row).finally(() => advancing.delete(key));
  advancing.set(key, p);
  return p;
}

async function advanceOnce(ctx: AppContext, row: TopicSearchRow): Promise<void> {
  const now = ctx.now();
  const fail = (error: string) =>
    ctx.db.prepare("UPDATE topic_search SET status = 'failed', error = ?, checked_at = ?, completed_at = ? WHERE id = ? AND status = 'running'").run(error, now, now, row.id);
  if (!ctx.podcastSearch) {
    fail("topic search was turned off before this search finished");
    return;
  }
  let run;
  try {
    run = await ctx.podcastSearch.check(row.run_id);
  } catch (err) {
    // A failed check is not a failed search: the next read asks again, until GIVE_UP_MS.
    ctx.log("topic search: check failed", { id: row.id, error: String(err) });
    run = { status: "running" as const };
  }
  if (run.status === "running") {
    if (now - row.created_at >= GIVE_UP_MS) fail("the search took too long");
    else ctx.db.prepare("UPDATE topic_search SET checked_at = ? WHERE id = ?").run(now, row.id);
    return;
  }
  if (run.status === "failed") {
    fail(run.error);
    return;
  }
  const shows = await lookUpShows(ctx, run.episodes);
  ctx.db
    .prepare("UPDATE topic_search SET status = 'completed', episodes = ?, shows = ?, cost_dollars = ?, podcast_index_calls = ?, error = NULL, checked_at = ?, completed_at = ? WHERE id = ? AND status = 'running'")
    .run(JSON.stringify(run.episodes), JSON.stringify(shows), run.cost_dollars, run.podcast_index_calls, now, now, row.id);
  ctx.log("topic search: completed", { id: row.id, episodes: run.episodes.length, cost_dollars: run.cost_dollars, podcast_index_calls: run.podcast_index_calls });
}

/** Shows we have no feed for are looked up once in the directory (free), so the owner can open them. */
async function lookUpShows(ctx: AppContext, found: FoundEpisode[]): Promise<Record<string, ShowResult | null>> {
  const feeds = allFeeds(ctx);
  const out: Record<string, ShowResult | null> = {};
  for (const f of found) {
    if (f.podcast in out || feedByTitle(feeds, f.podcast)) continue;
    if (f.url && youtubeIdFrom(f.url)) continue;
    try {
      const results = await ctx.showSearch.search(f.podcast, 5);
      out[f.podcast] = results.find((r) => sameTitle(r.title, f.podcast)) ?? null;
    } catch (err) {
      ctx.log("topic search: show lookup failed", { source: ctx.showSearch.name, error: String(err) });
      out[f.podcast] = null;
    }
  }
  return out;
}

type FeedLite = Pick<FeedRow, "id" | "title" | "url_hash" | "followed" | "kind">;

function allFeeds(ctx: AppContext): FeedLite[] {
  return ctx.db.prepare("SELECT id, title, url_hash, followed, kind FROM feed WHERE kind IN ('podcast', 'youtube')").all() as FeedLite[];
}

function sameTitle(a: string, b: string): boolean {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  return x.length > 0 && (x === y || titleSimilarity(x, y) >= 0.9);
}

function feedByTitle(feeds: FeedLite[], podcast: string): FeedLite | undefined {
  return feeds.find((f) => f.title !== null && sameTitle(f.title, podcast));
}

/** A page link compared loosely: no scheme, no www., no query or fragment, no trailing slash, host in lower case. */
export function pageKey(u: string): string | null {
  try {
    const url = new URL(u.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.hostname.toLowerCase().replace(/^www\./, "")}${path}`;
  } catch {
    return null;
  }
}

function normalizeFeedUrl(u: string): string {
  try { return new URL(u.trim()).toString(); } catch { return u; }
}

function view(ctx: AppContext, row: TopicSearchRow): TopicSearchView {
  const found = row.episodes ? (JSON.parse(row.episodes) as FoundEpisode[]) : [];
  const shows = row.shows ? (JSON.parse(row.shows) as Record<string, ShowResult | null>) : {};
  const feeds = found.length ? allFeeds(ctx) : [];
  const byHash = new Map(feeds.map((f) => [f.url_hash, f]));
  return {
    id: row.id,
    query: row.query,
    status: row.status,
    error: row.error,
    results: found.map((f) => matchOne(ctx, f, feeds, byHash, shows[f.podcast] ?? null)),
    cost_dollars: row.cost_dollars,
    podcast_index_calls: row.podcast_index_calls,
    created_at: row.created_at,
    completed_at: row.completed_at,
  };
}

function matchOne(ctx: AppContext, f: FoundEpisode, feeds: FeedLite[], byHash: Map<string, FeedLite>, show: ShowResult | null): TopicResult {
  const youtubeId = f.url ? youtubeIdFrom(f.url) : null;
  const base = { podcast: f.podcast, title: f.episode, published: f.published, url: f.url, speaker: f.speaker, quote: f.quote, why: f.why, start_ms: f.start_seconds === null ? null : f.start_seconds * 1000, youtube_id: youtubeId };
  const found = (ep: EpisodeRow): TopicResult => {
    const feed = feeds.find((x) => x.id === ep.feed_id);
    return { ...base, match: "episode", episode: episodeListItem(ctx, ep), feed_id: ep.feed_id, followed: feed ? feed.followed === 1 : null, show: null };
  };
  if (youtubeId) {
    const ep = ctx.db.prepare("SELECT * FROM episode WHERE youtube_id = ? ORDER BY media_kind = 'video' DESC LIMIT 1").get(youtubeId) as EpisodeRow | undefined;
    if (ep) return found(ep);
  }
  // The episode's own page, as its feed links it: titles drift (a show renames an episode), links rarely do. A bare
  // site (no path) is a show's home page, not an episode's.
  const key = f.url && !youtubeId ? pageKey(f.url) : null;
  if (key && key.includes("/")) {
    const host = key.slice(0, key.indexOf("/"));
    const candidates = ctx.db.prepare("SELECT * FROM episode WHERE link LIKE ?").all(`%${host}%`) as EpisodeRow[];
    const ep = candidates.find((e) => e.link !== null && pageKey(e.link) === key);
    if (ep) return found(ep);
  }
  const feed = feedByTitle(feeds, f.podcast) ?? (show ? byHash.get(ctx.secrets.hash(normalizeFeedUrl(show.feed_url))) : undefined);
  if (feed) {
    const episodes = ctx.db.prepare("SELECT * FROM episode WHERE feed_id = ?").all(feed.id) as EpisodeRow[];
    const ep = findEpisodeByTitle(episodes, f.episode);
    if (ep) return found(ep);
    return { ...base, match: "show", episode: null, feed_id: feed.id, followed: feed.followed === 1, show: null };
  }
  if (show) return { ...base, match: "new_show", episode: null, feed_id: null, followed: null, show: { title: show.title, author: show.author, feed_url: show.feed_url, artwork_url: show.artwork_url } };
  if (youtubeId) return { ...base, match: "video", episode: null, feed_id: null, followed: null, show: null };
  return { ...base, match: "none", episode: null, feed_id: null, followed: null, show: null };
}
