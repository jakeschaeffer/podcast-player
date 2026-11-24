import { createServer } from "node:http";
import { expect, it } from "vitest";
import { drain } from "../src/jobs/worker.js";
import { addFeed } from "../src/services/feeds.js";
import { testContext } from "./helpers/context.js";

const entry = (id: string, path: string) => `<entry>
  <id>yt:video:${id}</id><yt:videoId>${id}</yt:videoId><title>${id}</title>
  <link rel="alternate" href="https://www.youtube.com/${path}"/>
  <published>2026-11-20T15:00:00+00:00</published>
 </entry>`;

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <yt:channelId>UCXl4i9dYBrFOabk0xGmbkRA</yt:channelId>
 <title>Dwarkesh Patel</title>
 ${entry("QAE9nRTHtas", "shorts/QAE9nRTHtas")}
 ${entry("SyHM5hNPAEo", "watch?v=SyHM5hNPAEo")}
 ${entry("Ru0l6G5oq7U", "shorts/Ru0l6G5oq7U")}
</feed>`;

it("leaves a channel's Shorts out of the library", async () => {
  const server = createServer((_req, res) => res.writeHead(200, { "content-type": "application/atom+xml" }).end(FEED));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  const ctx = testContext();
  try {
    const feed = addFeed(ctx, { url: `http://127.0.0.1:${addr.port}/feed`, auto_process: false });
    ctx.db.prepare("UPDATE feed SET kind = 'youtube' WHERE id = ?").run(feed.id);
    await drain(ctx, { kinds: ["refresh_feed"] });
    expect(ctx.db.prepare("SELECT youtube_id FROM episode WHERE feed_id = ?").pluck().all(feed.id)).toEqual(["SyHM5hNPAEo"]);
  } finally {
    ctx.db.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
