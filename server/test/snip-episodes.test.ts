import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/http/app.js";
import { newId } from "../src/lib/ids.js";
import { testContext } from "./helpers/context.js";

/**
 * The Snips tab by episode: every episode with a snip, the most recently snipped first, with its count, and the
 * shows they come from for filtering.
 */
describe("snips by episode", () => {
  const ctx = testContext();
  let app: FastifyInstance;
  let token: string;
  const auth = () => ({ authorization: `Bearer ${token}` });
  const feedA = newId();
  const feedB = newId();
  const ep: Record<string, string> = {};

  /** An episode of `feed` with one recording; snips at the given tap times (ms), the last one deleted when asked. */
  function episode(name: string, feed: string, taps: number[], opts: { deletedTap?: number; video?: boolean } = {}) {
    const id = newId();
    ep[name] = id;
    ctx.db.prepare("INSERT INTO episode (id, feed_id, guid, title, first_seen_at, enclosure_url_enc) VALUES (?, ?, ?, ?, 0, ?)").run(id, feed, id, name, Buffer.from("x"));
    // Two recordings for the video episode: snips from either count as the episode's.
    const assets = (opts.video ? [0, 1] : [0]).map(() => {
      const asset = newId();
      ctx.db.prepare("INSERT INTO audio_asset (id, episode_id, sha256, bytes, duration_ms, mime, path, created_at) VALUES (?, ?, ?, 1, 600000, 'audio/mpeg', '/x', 0)").run(asset, id, asset);
      return asset;
    });
    const add = (at: number, deleted: boolean, i: number) => {
      const snip = newId();
      ctx.db
        .prepare("INSERT INTO snip (id, audio_asset_id, anchor_ms, heard_from_ms, client_request_id, share_token, created_at, captured_at, deleted_at) VALUES (?, ?, 1000, 0, ?, ?, ?, ?, ?)")
        .run(snip, assets[i % assets.length], snip, snip, at + 5, at, deleted ? at + 10 : null);
    };
    taps.forEach((at, i) => add(at, false, i));
    if (opts.deletedTap !== undefined) add(opts.deletedTap, true, 0);
  }

  beforeAll(async () => {
    ctx.db.prepare("INSERT INTO feed (id, url_enc, url_hash, title, image_url, created_at) VALUES (?, ?, ?, 'Show A', 'https://a.example/art.jpg', 0)").run(feedA, Buffer.from("a"), feedA);
    ctx.db.prepare("INSERT INTO feed (id, url_enc, url_hash, title, created_at) VALUES (?, ?, ?, 'Show B', 0)").run(feedB, Buffer.from("b"), feedB);
    episode("old A", feedA, [1_000, 2_000]);
    episode("new B", feedB, [5_000]);
    // Its newest snip was deleted, so it ranks by the one still there.
    episode("middle A", feedA, [3_000, 3_500, 4_000], { deletedTap: 9_000, video: true });
    ctx.db.prepare("INSERT INTO episode (id, feed_id, guid, title, first_seen_at, enclosure_url_enc) VALUES (?, ?, 'none', 'never snipped', 0, ?)").run(newId(), feedA, Buffer.from("x"));
    app = await buildApp(ctx);
    token = (await app.inject({ method: "POST", url: "/v1/devices", payload: { name: "phone", platform: "ios", password: ctx.config.ownerPassword } })).json().token;
  });
  afterAll(() => app.close());

  it("lists episodes with snips, the most recently snipped first, with their counts", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/snips/episodes", headers: auth() });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as { episode_id: string; episode_title: string; snip_count: number; last_snipped_at: number; show_title: string; image_url: string | null }[];
    expect(items.map((i) => i.episode_title)).toEqual(["new B", "middle A", "old A"]);
    expect(items.map((i) => i.snip_count)).toEqual([1, 3, 2]);
    expect(items[1]).toMatchObject({ last_snipped_at: 4_000, show_title: "Show A", image_url: "https://a.example/art.jpg" });
    expect(res.json().next).toBeNull();
  });

  it("keeps one show's episodes", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/snips/episodes?feed_id=${feedA}`, headers: auth() });
    expect(res.json().items.map((i: { episode_id: string }) => i.episode_id)).toEqual([ep["middle A"], ep["old A"]]);
  });

  it("pages with the cursor it hands out", async () => {
    const first = (await app.inject({ method: "GET", url: "/v1/snips/episodes?limit=2", headers: auth() })).json();
    expect(first.items).toHaveLength(2);
    expect(first.next).toBe(`4000:${ep["middle A"]}`);
    const second = (await app.inject({ method: "GET", url: `/v1/snips/episodes?limit=2&after=${encodeURIComponent(first.next)}`, headers: auth() })).json();
    expect(second.items.map((i: { episode_title: string }) => i.episode_title)).toEqual(["old A"]);
    expect(second.next).toBeNull();
    expect((await app.inject({ method: "GET", url: "/v1/snips/episodes?after=nonsense", headers: auth() })).statusCode).toBe(400);
  });

  it("lists the shows snipped from, with episode and snip counts", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/snips/shows", headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([
      { feed_id: feedB, title: "Show B", image_url: null, episode_count: 1, snip_count: 1, last_snipped_at: 5_000 },
      { feed_id: feedA, title: "Show A", image_url: "https://a.example/art.jpg", episode_count: 2, snip_count: 5, last_snipped_at: 4_000 },
    ]);
  });
});
