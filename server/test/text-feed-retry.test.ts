import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../src/app/context.js";
import { drain } from "../src/jobs/worker.js";
import { addFeed, getFeedRow } from "../src/services/feeds.js";
import { testContext } from "./helpers/context.js";

// Stratechery posts the article about an hour before the podcast item (2026-10-28: text feed 10:07, podcast 11:17).
// The text feed's refresh must keep retrying that article until its episode exists, even though the text feed
// itself does not change again (it would answer 304 to a conditional request).
describe("an article that arrives before its episode", () => {
  let fixtures: Server;
  let baseUrl: string;
  let ctx: AppContext;
  const now = Date.now();
  const hourAgo = new Date(now - 3_600_000).toUTCString();
  let episodes: { title: string; guid: string; date: string }[] = [{ title: "Last Week's Update", guid: "p0", date: new Date(now - 7 * 86_400_000).toUTCString() }];
  const textRequests: { conditional: boolean; status: number }[] = [];

  const body = (words: number) => `<p>${Array.from({ length: words }, (_, i) => `word${i}`).join(" ")}.</p>`;
  const podcastXml = () => `<?xml version="1.0"?><rss version="2.0"><channel><title>Show</title>${episodes
    .map((e) => `<item><title>${e.title}</title><guid>${e.guid}</guid><pubDate>${e.date}</pubDate><enclosure url="${baseUrl}/${e.guid}.mp3" type="audio/mpeg"/></item>`)
    .join("")}</channel></rss>`;
  const textXml = `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Show Articles</title>
    <item><title>Meta Earnings, Muse and the Frontier</title><guid>t1</guid><pubDate>${hourAgo}</pubDate><link>https://show.test/t1</link><content:encoded><![CDATA[${body(80)}]]></content:encoded></item>
    <item><title>An Interview From Last Year</title><guid>t0</guid><pubDate>${new Date(now - 300 * 86_400_000).toUTCString()}</pubDate><link>https://show.test/t0</link><content:encoded><![CDATA[${body(80)}]]></content:encoded></item>
    </channel></rss>`;

  beforeAll(async () => {
    ctx = testContext();
    fixtures = createServer((req, res) => {
      if (req.url === "/text.xml") {
        const conditional = req.headers["if-none-match"] === '"text-v1"';
        textRequests.push({ conditional, status: conditional ? 304 : 200 });
        if (conditional) return void res.writeHead(304).end();
        return void res.writeHead(200, { "content-type": "application/rss+xml", etag: '"text-v1"' }).end(textXml);
      }
      if (req.url === "/podcast.xml") return void res.writeHead(200, { "content-type": "application/rss+xml" }).end(podcastXml());
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => fixtures.listen(0, "127.0.0.1", resolve));
    const addr = fixtures.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterAll(() => fixtures.close());

  it("keeps re-reading the text feed until the episode lands, then matches it at once", async () => {
    const podcast = addFeed(ctx, { url: `${baseUrl}/podcast.xml`, auto_process: false });
    const text = addFeed(ctx, { url: `${baseUrl}/text.xml`, kind: "text", text_for_feed_id: podcast.id, auto_process: false });
    await drain(ctx, { kinds: ["refresh_feed"] });
    const texts = () => ctx.db.prepare("SELECT episode_id FROM episode_text").pluck().all();
    expect(texts()).toEqual([]);
    // The fresh article has no episode yet, so the feed's validators are dropped; the year-old one alone would not.
    expect(getFeedRow(ctx, text.id).etag).toBeNull();

    // The text feed's next scheduled turn downloads it again rather than getting a 304.
    ctx.queue.enqueue("refresh_feed", `refresh_feed:${text.id}`, { feed_id: text.id }, { rerun: true });
    await drain(ctx, { kinds: ["refresh_feed"] });
    expect(textRequests.map((r) => r.status)).toEqual([200, 200]);
    expect(texts()).toEqual([]);

    // The episode appears an hour later. Refreshing the podcast feed re-reads the text feed straight away.
    episodes = [...episodes, { title: "Meta Earnings, Muse and the Frontier", guid: "p1", date: new Date(now).toUTCString() }];
    ctx.queue.enqueue("refresh_feed", `refresh_feed:${podcast.id}`, { feed_id: podcast.id }, { rerun: true });
    await drain(ctx, { kinds: ["refresh_feed"] });
    const episodeId = ctx.db.prepare("SELECT id FROM episode WHERE guid = 'p1'").pluck().get();
    expect(texts()).toEqual([episodeId]);
    expect(textRequests).toHaveLength(3);

    // Once nothing recent is waiting, the feed goes back to conditional requests.
    expect(getFeedRow(ctx, text.id).etag).toBe('"text-v1"');
    ctx.queue.enqueue("refresh_feed", `refresh_feed:${text.id}`, { feed_id: text.id }, { rerun: true });
    await drain(ctx, { kinds: ["refresh_feed"] });
    expect(textRequests.at(-1)).toEqual({ conditional: true, status: 304 });
  });
});
