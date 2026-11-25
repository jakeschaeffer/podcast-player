import { createServer } from "node:http";
import { expect, it } from "vitest";
import { drain } from "../src/jobs/worker.js";
import { addFeed } from "../src/services/feeds.js";
import { testContext } from "./helpers/context.js";

// An article stored before the extractor learned something (here: Tangle's headings drawn as role="heading" divs)
// is read again on the next refresh, as long as it has not been aligned; an aligned one keeps the text its timings fit.
it("re-reads a stored article that is not aligned yet, and leaves an aligned one alone", async () => {
  const now = Date.now();
  const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
  const article = `<h3>Today’s topic.</h3><p>${words(40)}.</p><div role="heading" aria-level="3">What the left is saying.</div><ul><li>${words(30)}.</li></ul>`;
  const podcastXml = `<?xml version="1.0"?><rss version="2.0"><channel><title>Tangle</title>
    <item><title>The tech outages.</title><guid>p1</guid><pubDate>${new Date(now).toUTCString()}</pubDate><enclosure url="http://x.test/p1.mp3" type="audio/mpeg"/></item></channel></rss>`;
  const textXml = `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Tangle</title>
    <item><title>The tech outages.</title><guid>t1</guid><pubDate>${new Date(now).toUTCString()}</pubDate><content:encoded><![CDATA[${article}]]></content:encoded></item></channel></rss>`;
  const server = createServer((req, res) => res.writeHead(200, { "content-type": "application/rss+xml" }).end(req.url === "/text.xml" ? textXml : podcastXml));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const ctx = testContext();
  try {
    const podcast = addFeed(ctx, { url: `${base}/podcast.xml`, auto_process: false });
    await drain(ctx, { kinds: ["refresh_feed"] });
    const text = addFeed(ctx, { url: `${base}/text.xml`, kind: "text", text_for_feed_id: podcast.id, auto_process: false });
    await drain(ctx, { kinds: ["refresh_feed"] });
    const sections = () => (JSON.parse(ctx.db.prepare("SELECT sections FROM episode_text").pluck().get() as string) as { title: string }[]).map((s) => s.title);
    expect(sections()).toEqual(["Today’s topic.", "What the left is saying."]);

    // As an older extractor stored it: the div heading missed.
    ctx.db.prepare("UPDATE episode_text SET sections = ?").run(JSON.stringify([{ title: "Today’s topic.", first_paragraph: 0 }]));
    const refresh = async () => {
      ctx.queue.enqueue("refresh_feed", `refresh_feed:${text.id}`, { feed_id: text.id }, { rerun: true });
      await drain(ctx, { kinds: ["refresh_feed"] });
    };
    await refresh();
    expect(sections()).toEqual(["Today’s topic.", "What the left is saying."]);

    // Once aligned, the stored text stays as it is.
    const textId = ctx.db.prepare("SELECT id FROM episode_text").pluck().get();
    const episodeId = ctx.db.prepare("SELECT id FROM episode").pluck().get();
    ctx.db.prepare("INSERT INTO audio_asset (id, episode_id, sha256, bytes, duration_ms, mime, path, created_at) VALUES ('a1', ?, 'h', 1, 1000, 'audio/mpeg', '/x', 0)").run(episodeId);
    ctx.db.prepare("INSERT INTO transcript (id, audio_asset_id, provider, model, word_count, created_at, source, text_id) VALUES ('t1', 'a1', 'elevenlabs', 'forced_alignment', 70, 0, 'rss', ?)").run(textId);
    ctx.db.prepare("UPDATE episode_text SET sections = '[]'").run();
    await refresh();
    expect(sections()).toEqual([]);
  } finally {
    ctx.db.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
