import { describe, expect, it } from "vitest";
import { newId } from "../src/lib/ids.js";
import { addYouTubeVideo } from "../src/services/video.js";
import { testContext } from "./helpers/context.js";

/**
 * A pasted YouTube link (the part that needs no network): a video an episode already names is that episode, with its
 * video asked for; anything that is not a video link is refused. Reading a new video's watch page is exercised
 * against the live server.
 */
describe("addYouTubeVideo", () => {
  const ctx = testContext();
  const feedId = newId();
  const device = newId();
  ctx.db.prepare("INSERT INTO feed (id, url_enc, url_hash, title, created_at) VALUES (?, ?, ?, 'Show', 0)").run(feedId, Buffer.from("x"), feedId);
  ctx.db.prepare("INSERT INTO device (id, name, platform, token_hash, created_at) VALUES (?, 'phone', 'ios', ?, 0)").run(device, device);

  it("refuses anything but a video link", async () => {
    for (const url of ["https://www.youtube.com/@DwarkeshPatel", "https://example.com/watch?v=bJD1NpdMY5s", "not a url"]) {
      await expect(addYouTubeVideo(ctx, url, device)).rejects.toMatchObject({ status: 400 });
    }
  });

  it("gives back the episode that already names the video, and asks for its video", async () => {
    const episode = newId();
    ctx.db
      .prepare("INSERT INTO episode (id, feed_id, guid, title, first_seen_at, enclosure_url_enc, media_kind, youtube_id) VALUES (?, ?, ?, 'Caro', 0, ?, 'audio', 'f0J_EeW42Lo')")
      .run(episode, feedId, episode, Buffer.from("x"));
    const detail = await addYouTubeVideo(ctx, "https://youtu.be/f0J_EeW42Lo?t=12", device);
    expect(detail.id).toBe(episode);
    expect(detail.video.status).toBe("requested");
    expect(ctx.queue.byKey(`fetch_video:${episode}`)?.status).toBe("queued");
  });
});
