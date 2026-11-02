/** Finding a show and subscribing to it: what the web app's Add a show screen relies on. */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ShowResult, ShowSearch } from "../src/adapters/showSearch.js";
import type { AppContext } from "../src/app/context.js";
import { buildApp } from "../src/http/app.js";
import { FixedShowSearch, testContext } from "./helpers/context.js";

const show = (title: string, feed_url: string): ShowResult => ({ title, author: "Someone", feed_url, artwork_url: null, site_url: null, episode_count: 12, genres: ["Technology"], source: "itunes" });

let ctx: AppContext;
let app: FastifyInstance;
let token: string;
const search = new FixedShowSearch([
  show("Hard Fork", "https://feeds.example.com/hardfork"),
  show("Hard Fork (again)", "https://feeds.example.com/hardfork"),
  show("Acquired", "https://feeds.example.com/acquired.xml"),
]);
const auth = () => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  ctx = testContext({ showSearch: search });
  app = await buildApp(ctx);
  token = (await app.inject({ method: "POST", url: "/v1/devices", payload: { name: "web", platform: "web", password: "hunter2" } })).json().token;
});

afterAll(async () => {
  await app.close();
});

describe("show search", () => {
  it("returns one row per feed and marks shows already subscribed", async () => {
    const before = (await app.inject({ method: "GET", url: "/v1/search/shows?q=hard%20fork", headers: auth() })).json();
    expect(before.source).toBe("fixed");
    expect(before.results.map((r: { title: string }) => r.title)).toEqual(["Hard Fork", "Acquired"]);
    expect(before.results.every((r: { feed_id: string | null }) => r.feed_id === null)).toBe(true);

    // Subscribe the way the web app does: manual, so nothing is fetched or transcribed until asked.
    const added = await app.inject({ method: "POST", url: "/v1/feeds", headers: auth(), payload: { url: "https://feeds.example.com/acquired.xml", auto_process: false, backfill: 0 } });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toMatchObject({ auto_process: false, backfill: 0, is_private: false, last_refresh_at: null });
    expect(ctx.db.prepare("SELECT kind FROM job WHERE status = 'queued'").pluck().all()).toEqual(["refresh_feed"]); // reading the RSS is free

    const after = (await app.inject({ method: "GET", url: "/v1/search/shows?q=hard%20fork", headers: auth() })).json();
    expect(after.results.find((r: { title: string }) => r.title === "Acquired").feed_id).toBe(added.json().id);
    const again = await app.inject({ method: "POST", url: "/v1/feeds", headers: auth(), payload: { url: "https://feeds.example.com/acquired.xml" } });
    expect(again.statusCode).toBe(409);
  });

  it("rejects one-letter queries and reports a failing directory as 502", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/search/shows?q=a", headers: auth() })).statusCode).toBe(400);
    const broken: ShowSearch = { name: "itunes", search: async () => { throw new Error("itunes search: 503"); } };
    ctx.showSearch = broken;
    try {
      const res = await app.inject({ method: "GET", url: "/v1/search/shows?q=hard%20fork", headers: auth() });
      expect(res.statusCode).toBe(502);
      expect(res.json().error.message).toMatch(/unavailable/);
    } finally {
      ctx.showSearch = search;
    }
  });
});
