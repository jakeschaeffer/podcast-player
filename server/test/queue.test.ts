import { describe, expect, it } from "vitest";
import { PRIORITY } from "../src/jobs/queue.js";
import { newId } from "../src/lib/ids.js";
import { addToQueue, listQueue, removeFromQueue, setQueueOrder } from "../src/services/episodes.js";
import { testContext } from "./helpers/context.js";

// Up next is every half-heard episode, the one listened to last first, whichever device it was on.
describe("the queue", () => {
  const ctx = testContext();
  const feedId = newId();
  ctx.db.prepare("INSERT INTO feed (id, url_enc, url_hash, title, created_at) VALUES (?, ?, ?, 'Show', 0)").run(feedId, Buffer.from("x"), feedId);
  const devices = ["phone", "laptop"].map((name) => {
    const id = newId();
    ctx.db.prepare("INSERT INTO device (id, name, platform, token_hash, created_at) VALUES (?, ?, 'ios', ?, 0)").run(id, name, id);
    return id;
  });
  const ids = new Map<string, string>();
  const episode = (title: string) => {
    const id = newId();
    ids.set(title, id);
    const asset = newId();
    ctx.db.prepare("INSERT INTO episode (id, feed_id, guid, title, first_seen_at, enclosure_url_enc) VALUES (?, ?, ?, ?, 0, ?)").run(id, feedId, id, title, Buffer.from("x"));
    ctx.db.prepare("INSERT INTO audio_asset (id, episode_id, sha256, bytes, duration_ms, mime, path, created_at) VALUES (?, ?, ?, 1, 600000, 'audio/mpeg', '/x', 0)").run(asset, id, asset);
    ctx.db.prepare("UPDATE episode SET current_asset_id = ? WHERE id = ?").run(asset, id);
    return asset;
  };
  const play = (asset: string, at: number, position: number, finished = false, device = devices[0]) =>
    ctx.db
      .prepare("INSERT OR REPLACE INTO playback_state (device_id, audio_asset_id, position_ms, finished, seq, updated_at, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(device, asset, position, finished ? 1 : 0, at, at, at);
  const titles = () => listQueue(ctx).items.map((e) => e.title);

  const a = episode("A");
  const b = episode("B");
  const c = episode("C");
  const d = episode("D");
  episode("Never played");

  it("lists started, unfinished episodes, most recently listened first", () => {
    play(a, 1_000, 60_000);
    play(b, 2_000, 30_000);
    play(c, 3_000, 0); // opened but never played
    play(d, 4_000, 600_000, true); // finished
    expect(titles()).toEqual(["B", "A"]);
  });

  it("moves an episode to the top when it is left for another", () => {
    play(a, 5_000, 90_000); // back to A, then on to something new: A's last report is the newest
    expect(titles()).toEqual(["A", "B"]);
  });

  it("follows the latest report from any device", () => {
    play(b, 6_000, 45_000, false, devices[1]);
    expect(titles()).toEqual(["B", "A"]);
    play(b, 7_000, 600_000, true, devices[1]); // finished on the laptop, so it leaves the queue
    expect(titles()).toEqual(["A"]);
    expect(listQueue(ctx).items[0]!.resume).toMatchObject({ position_ms: 90_000, finished: false });
  });

  it("keeps the owner's order once they place episodes", () => {
    let now = 10_000;
    ctx.now = () => now;
    play(b, 8_000, 30_000); // B half-heard again
    expect(titles()).toEqual(["B", "A"]);
    setQueueOrder(ctx, [ids.get("A")!, ids.get("B")!]);
    expect(titles()).toEqual(["A", "B"]);
    now = 11_000;
    addToQueue(ctx, ids.get("Never played")!); // added at the end
    expect(titles()).toEqual(["A", "B", "Never played"]);
    setQueueOrder(ctx, [ids.get("Never played")!, ids.get("A")!, ids.get("B")!]);
    expect(titles()).toEqual(["Never played", "A", "B"]);
  });

  it("puts an episode listened to after it was placed back at the top", () => {
    play(b, 12_000, 40_000);
    expect(titles()).toEqual(["B", "Never played", "A"]);
  });

  it("takes an episode out until it is played again or added back", () => {
    ctx.now = () => 13_000;
    removeFromQueue(ctx, ids.get("A")!);
    expect(titles()).toEqual(["B", "Never played"]);
    play(a, 14_000, 95_000); // listened to again: back, at the top
    expect(titles()).toEqual(["A", "B", "Never played"]);
    ctx.now = () => 15_000;
    removeFromQueue(ctx, ids.get("Never played")!);
    expect(titles()).toEqual(["A", "B"]);
    ctx.now = () => 16_000;
    addToQueue(ctx, ids.get("Never played")!);
    expect(titles()).toEqual(["A", "B", "Never played"]);
  });

  it("drops an added episode once it is finished, and adds it back on request", () => {
    play(d, 17_000, 600_000, true); // D was finished before; adding brings it back
    ctx.now = () => 18_000;
    addToQueue(ctx, ids.get("D")!);
    expect(titles()).toContain("D");
    play(d, 19_000, 600_000, true);
    expect(titles()).not.toContain("D");
  });

  it("fetches and transcribes an added episode at the owner's priority", () => {
    const id = newId();
    ctx.db.prepare("INSERT INTO episode (id, feed_id, guid, title, first_seen_at, enclosure_url_enc) VALUES (?, ?, ?, 'No audio yet', 0, ?)").run(id, feedId, id, Buffer.from("x"));
    addToQueue(ctx, id);
    const job = ctx.db.prepare("SELECT kind, payload, priority FROM job WHERE key = ?").get(`fetch_audio:${id}`) as { kind: string; payload: string; priority: number } | undefined;
    expect(job?.kind).toBe("fetch_audio");
    expect(JSON.parse(job!.payload)).toMatchObject({ episode_id: id, then: "transcribe" });
    expect(job!.priority).toBe(PRIORITY.upNext);
    // One with its recording but no transcript is transcribed straight away.
    addToQueue(ctx, ids.get("C")!);
    const transcribe = ctx.db.prepare("SELECT priority FROM job WHERE key = ?").get(`transcribe:${c}`) as { priority: number } | undefined;
    expect(transcribe?.priority).toBe(PRIORITY.upNext);
  });
});
