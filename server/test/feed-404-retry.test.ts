import { createServer } from "node:http";
import { expect, it } from "vitest";
import { drain } from "../src/jobs/worker.js";
import { addFeed, getFeedRow } from "../src/services/feeds.js";
import { testContext } from "./helpers/context.js";

it("retries a YouTube 404 with backoff and clears the error on recovery", async () => {
  let status = 404;
  let requests = 0;
  let now = Date.now();
  const server = createServer((_req, res) => { requests++; res.writeHead(status).end(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  const ctx = testContext({ now: () => now });
  try {
    const feed = addFeed(ctx, { url: `http://127.0.0.1:${addr.port}/feed`, auto_process: false });
    ctx.db.prepare("UPDATE feed SET kind = 'youtube' WHERE id = ?").run(feed.id);
    const job = () => ctx.db.prepare("SELECT status, attempts, run_after FROM job WHERE key = ?").get(`refresh_feed:${feed.id}`);
    await drain(ctx, { kinds: ["refresh_feed"] });
    expect(job()).toMatchObject({ status: "queued", attempts: 1, run_after: now + 30_000 });
    expect(getFeedRow(ctx, feed.id).last_error).toBe("feed not found (404)");
    await drain(ctx, { kinds: ["refresh_feed"] });
    expect(requests).toBe(1);
    now += 30_000;
    status = 304;
    await drain(ctx, { kinds: ["refresh_feed"] });
    expect(job()).toMatchObject({ status: "done", attempts: 2 });
    expect(getFeedRow(ctx, feed.id).last_error).toBeNull();

    for (const [kind, code] of [["podcast", 404], ["youtube", 410], ["youtube", 403], ["youtube", 401]] as const) {
      status = code;
      ctx.db.prepare("UPDATE feed SET kind = ? WHERE id = ?").run(kind, feed.id);
      ctx.queue.enqueue("refresh_feed", `refresh_feed:${feed.id}`, { feed_id: feed.id }, { rerun: true });
      await drain(ctx, { kinds: ["refresh_feed"] });
      expect(job()).toMatchObject({ status: "failed", attempts: 1 });
    }
  } finally {
    ctx.db.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
