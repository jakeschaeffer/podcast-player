/** Topic search: Exa's podcast search, faked. Nothing here reaches the network or bills. */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExaPodcastSearch, foundEpisodes, MAX_EPISODES, readRun, type FoundEpisode } from "../src/adapters/exa.js";
import type { ShowResult } from "../src/adapters/showSearch.js";
import type { AppContext } from "../src/app/context.js";
import { buildApp } from "../src/http/app.js";
import { NonRetryable } from "../src/jobs/errors.js";
import { newId } from "../src/lib/ids.js";
import { addFeed } from "../src/services/feeds.js";
import { CHECK_EVERY_MS, GIVE_UP_MS, REUSE_MS } from "../src/services/topicSearch.js";
import { FakePodcastSearch, FixedShowSearch, testContext } from "./helpers/context.js";

const found = (podcast: string, episode: string, extra: Partial<FoundEpisode> = {}): FoundEpisode => ({
  podcast, episode, published: "2026-10-01", url: null, speaker: "A Guest", quote: "Sleep is when the day gets filed.", why: "A sleep researcher on memory.", start_seconds: 1908, ...extra,
});
const show = (title: string, feed_url: string): ShowResult => ({ title, author: "Someone", feed_url, artwork_url: "https://img.example.com/a.jpg", site_url: null, episode_count: 40, genres: [], source: "itunes" });

function addShow(ctx: AppContext, url: string, title: string, followed = true): string {
  const id = addFeed(ctx, { url, followed }).id;
  ctx.db.prepare("UPDATE feed SET title = ? WHERE id = ?").run(title, id);
  return id;
}
function addEpisode(ctx: AppContext, feedId: string, title: string, youtubeId: string | null = null): string {
  const id = newId();
  ctx.db
    .prepare("INSERT INTO episode (id, feed_id, guid, title, published_at, first_seen_at, enclosure_url_enc, media_kind, youtube_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, feedId, `guid-${id}`, title, 1_790_000_000_000, 1_790_000_000_000, ctx.secrets.encrypt(`https://cdn.example.com/${id}.mp3`), youtubeId ? "video" : "audio", youtubeId);
  return id;
}

describe("the Exa adapter", () => {
  it("asks for a Particle run with a bounded episode list, and reads the run back", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (init.method === "POST") return Response.json({ id: "agent_run_01", status: "queued" });
      return Response.json({ id: "agent_run_01", status: "completed", output: { structured: { episodes: [{ podcast: "Huberman Lab", episode: "Sleep and Memory", start_seconds: 61.6, url: "javascript:alert(1)" }] } }, costDollars: { total: 0.055 } });
    }) as unknown as typeof fetch;
    const exa = new ExaPodcastSearch({ apiKey: "test-key", effort: "low", fetch: fakeFetch, base: "https://exa.test" });
    expect(await exa.start("sleep and memory")).toEqual({ run_id: "agent_run_01" });
    const created = calls[0]!;
    expect(created.url).toBe("https://exa.test/agent/runs");
    expect((created.init.headers as Record<string, string>)["x-api-key"]).toBe("test-key");
    const body = JSON.parse(String(created.init.body));
    expect(body).toMatchObject({ effort: "low", dataSources: [{ provider: "particle" }] });
    expect(body.query).toContain("sleep and memory");
    expect(body.outputSchema.properties.episodes.maxItems).toBe(MAX_EPISODES);
    expect(body.budget).toBeUndefined(); // a fixed effort rejects a budget

    const run = await exa.check("agent_run_01");
    expect(calls[1]!.url).toBe("https://exa.test/agent/runs/agent_run_01");
    expect(calls[1]!.init.method).toBe("GET");
    expect(run).toEqual({ status: "completed", cost_dollars: 0.055, episodes: [{ podcast: "Huberman Lab", episode: "Sleep and Memory", published: null, url: null, speaker: null, quote: null, why: null, start_seconds: 62 }] });
  });

  it("reads only completed runs as results, and refuses a bad key for good", async () => {
    expect(readRun({ status: "running" })).toEqual({ status: "running" });
    expect(readRun({ status: "queued" })).toEqual({ status: "running" });
    expect(readRun({ status: "failed", error: { message: "TIMEOUT" } })).toEqual({ status: "failed", error: "TIMEOUT" });
    expect(readRun({ status: "cancelled" }).status).toBe("failed");
    expect(readRun({ status: "completed", output: { structured: null } })).toEqual({ status: "completed", episodes: [], cost_dollars: null });
    expect(foundEpisodes({ episodes: [{ podcast: "", episode: "x" }, "junk", { podcast: "P", episode: "E", start_seconds: -4 }] })).toEqual([{ podcast: "P", episode: "E", published: null, url: null, speaker: null, quote: null, why: null, start_seconds: null }]);

    const refused = new ExaPodcastSearch({ apiKey: "bad", effort: "low", fetch: (async () => new Response("invalid key", { status: 401 })) as unknown as typeof fetch });
    await expect(refused.start("x")).rejects.toBeInstanceOf(NonRetryable);
    const busy = new ExaPodcastSearch({ apiKey: "k", effort: "low", fetch: (async () => new Response("slow down", { status: 429 })) as unknown as typeof fetch });
    await expect(busy.check("r")).rejects.not.toBeInstanceOf(NonRetryable);
  });
});

describe("topic search off", () => {
  it("says so, and refuses to start a search", async () => {
    const ctx = testContext();
    const app = await buildApp(ctx);
    const token = (await app.inject({ method: "POST", url: "/v1/devices", payload: { name: "t", platform: "ios", password: "hunter2" } })).json().token;
    const headers = { authorization: `Bearer ${token}` };
    expect((await app.inject({ method: "GET", url: "/v1/topic-searches", headers })).json()).toEqual({ enabled: false, items: [] });
    const res = await app.inject({ method: "POST", url: "/v1/topic-searches", headers, payload: { query: "sleep" } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/EXA_API_KEY/);
    await app.close();
  });
});

describe("topic search", () => {
  let ctx: AppContext;
  let app: FastifyInstance;
  let token: string;
  let clock = 1_800_000_000_000;
  const exa = new FakePodcastSearch();
  const directory = new FixedShowSearch([show("Deep Questions", "https://feeds.example.com/deep.xml"), show("Unrelated Show", "https://feeds.example.com/other.xml")]);
  const headers = () => ({ authorization: `Bearer ${token}` });
  const post = (payload: object) => app.inject({ method: "POST", url: "/v1/topic-searches", headers: headers(), payload });
  const get = (id: string) => app.inject({ method: "GET", url: `/v1/topic-searches/${id}`, headers: headers() });

  let followedFeed: string;
  let browsedFeed: string;
  let episodeId: string;
  let videoEpisodeId: string;

  beforeAll(async () => {
    ctx = testContext({ podcastSearch: exa, showSearch: directory, now: () => clock });
    app = await buildApp(ctx);
    token = (await app.inject({ method: "POST", url: "/v1/devices", payload: { name: "t", platform: "ios", password: "hunter2" } })).json().token;
    followedFeed = addShow(ctx, "https://feeds.example.com/huberman.xml", "Huberman Lab");
    episodeId = addEpisode(ctx, followedFeed, "Dr. Matt Walker: Sleep & Memory");
    browsedFeed = addShow(ctx, "https://feeds.example.com/lex.xml", "Lex Fridman Podcast", false);
    const channel = addShow(ctx, "https://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv", "Some Channel");
    videoEpisodeId = addEpisode(ctx, channel, "A video about sleep", "dQw4w9WgXcQ");
    exa.episodes = [
      found("Huberman Lab", "Dr Matt Walker - Sleep and Memory"),
      found("Lex Fridman Podcast", "#999 – An episode we do not have"),
      found("Deep Questions", "Sleep and focus", { start_seconds: null }),
      found("A Channel We Lack", "Sleep, filmed", { url: "https://www.youtube.com/watch?v=abcdefghijk" }),
      found("Whatever Show", "Our own copy", { url: "https://youtu.be/dQw4w9WgXcQ" }),
      found("Nobody Has Heard Of This", "Mystery"),
    ];
  });

  afterAll(async () => {
    await app.close();
  });

  it("starts one billed run, polls it, and matches each episode it found", async () => {
    const started = await post({ query: "  sleep   and memory ", client_request_id: "req-1" });
    expect(started.statusCode).toBe(201);
    const search = started.json();
    expect(search).toMatchObject({ query: "sleep and memory", status: "running", results: [], error: null });
    expect(exa.starts).toEqual(["sleep and memory"]);

    // Within CHECK_EVERY_MS of the last look, a read does not ask Exa.
    expect((await get(search.id)).json().status).toBe("running");
    expect(exa.checks).toHaveLength(0);
    clock += CHECK_EVERY_MS;
    expect((await get(search.id)).json().status).toBe("running");
    expect(exa.checks).toHaveLength(1);
    clock += CHECK_EVERY_MS;
    const done = (await get(search.id)).json();
    expect(done.status).toBe("completed");
    expect(done.cost_dollars).toBe(0.04);
    expect(done.results.map((r: { match: string }) => r.match)).toEqual(["episode", "show", "new_show", "video", "episode", "none"]);

    const [mine, browsed, fresh, video, ownVideo, none] = done.results;
    expect(mine).toMatchObject({ podcast: "Huberman Lab", feed_id: followedFeed, followed: true, start_ms: 1_908_000, speaker: "A Guest", why: "A sleep researcher on memory." });
    expect(mine.episode).toMatchObject({ id: episodeId, title: "Dr. Matt Walker: Sleep & Memory", show_title: "Huberman Lab" });
    expect(browsed).toMatchObject({ feed_id: browsedFeed, followed: false, episode: null });
    expect(fresh).toMatchObject({ feed_id: null, show: { title: "Deep Questions", feed_url: "https://feeds.example.com/deep.xml" }, start_ms: null });
    expect(video).toMatchObject({ youtube_id: "abcdefghijk", url: "https://www.youtube.com/watch?v=abcdefghijk", show: null });
    expect(ownVideo.episode.id).toBe(videoEpisodeId);
    expect(none).toMatchObject({ show: null, feed_id: null, episode: null });
    // The directory is asked only about shows we have no feed for, and never about a YouTube link.
    expect(directory.queries).toEqual(["Deep Questions", "Nobody Has Heard Of This"]);

    // Once done, reads stop asking Exa.
    const checks = exa.checks.length;
    clock += CHECK_EVERY_MS;
    await get(search.id);
    expect(exa.checks).toHaveLength(checks);
  });

  it("gives the same search back for the same request or query, and bills again only after a day", async () => {
    const list = (await app.inject({ method: "GET", url: "/v1/topic-searches", headers: headers() })).json();
    expect(list.enabled).toBe(true);
    const first = list.items[0];
    const replay = await post({ query: "different words", client_request_id: "req-1" });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(first.id);
    const same = await post({ query: "Sleep and Memory" });
    expect(same.statusCode).toBe(200);
    expect(same.json().id).toBe(first.id);
    expect(exa.starts).toHaveLength(1);

    clock += REUSE_MS;
    const later = await post({ query: "sleep and memory" });
    expect(later.statusCode).toBe(201);
    expect(exa.starts).toHaveLength(2);
  });

  it("rematches on read: a show opened from the results turns its row into that show", async () => {
    const id = (await app.inject({ method: "GET", url: "/v1/topic-searches", headers: headers() })).json().items.find((s: { status: string }) => s.status === "completed").id;
    const opened = await app.inject({ method: "POST", url: "/v1/feeds", headers: headers(), payload: { url: "https://feeds.example.com/deep.xml", followed: false } });
    expect(opened.statusCode).toBe(201);
    const row = (await get(id)).json().results[2];
    expect(row).toMatchObject({ match: "show", feed_id: opened.json().id, followed: false });
    addEpisode(ctx, opened.json().id, "Sleep and Focus");
    expect((await get(id)).json().results[2].match).toBe("episode");
  });

  it("reports a failed run, keeps a run whose check failed, and gives up on one that never ends", async () => {
    const failing = (await post({ query: "a run that fails" })).json();
    exa.finish(`agent_run_fake${exa.starts.length}`, { status: "failed", error: "INVALID_DATA_SOURCE" });
    clock += CHECK_EVERY_MS;
    await get(failing.id); // the fake's one "running" answer
    clock += CHECK_EVERY_MS;
    expect((await get(failing.id)).json()).toMatchObject({ status: "failed", error: "INVALID_DATA_SOURCE", results: [] });
    // A failed search is not reused: asking again starts a new run.
    expect((await post({ query: "a run that fails" })).statusCode).toBe(201);

    exa.pending = 1_000_000;
    const slow = (await post({ query: "a run that never ends" })).json();
    const realCheck = exa.check.bind(exa);
    exa.check = async () => { throw new Error("socket hang up"); };
    clock += CHECK_EVERY_MS;
    expect((await get(slow.id)).json().status).toBe("running");
    exa.check = realCheck;
    clock += GIVE_UP_MS;
    expect((await get(slow.id)).json()).toMatchObject({ status: "failed", error: "the search took too long" });
    exa.pending = 1;
  });

  it("validates the query and answers 404 for an unknown search", async () => {
    expect((await post({ query: "x" })).statusCode).toBe(400);
    expect((await post({ query: "   " })).statusCode).toBe(400);
    expect((await get("01JUNKJUNKJUNKJUNKJUNKJUNK")).statusCode).toBe(404);
  });

  it("reports Exa refusing to start as 502, and bills nothing for it", async () => {
    const realStart = exa.start.bind(exa);
    exa.start = async () => { throw new Error("Exa POST /agent/runs answered 503"); };
    try {
      const res = await post({ query: "an outage" });
      expect(res.statusCode).toBe(502);
      expect(ctx.db.prepare("SELECT COUNT(*) FROM topic_search WHERE query = 'an outage'").pluck().get()).toBe(0);
    } finally {
      exa.start = realStart;
    }
  });
});
