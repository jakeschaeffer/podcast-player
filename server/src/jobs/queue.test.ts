import { describe, expect, it } from "vitest";
import { openDb } from "../db/index.js";
import { JobQueue, PRIORITY } from "./queue.js";

function queue() {
  let t = 1_000_000;
  const now = () => t;
  const q = new JobQueue(openDb(":memory:"), now);
  return { q, advance: (ms: number) => (t += ms) };
}

describe("JobQueue", () => {
  it("deduplicates by key and adopts the higher priority", () => {
    const { q } = queue();
    const a = q.enqueue("transcribe", "transcribe:asset1", { asset_id: "asset1" });
    const b = q.enqueue("transcribe", "transcribe:asset1", { asset_id: "asset1" }, { priority: PRIORITY.snip });
    expect(b).toEqual({ id: a.id, created: false });
    expect(q.get(a.id)!.priority).toBe(PRIORITY.snip);
  });

  it("claims by priority then age and only the requested kinds", () => {
    const { q, advance } = queue();
    q.enqueue("fetch_audio", "fetch_audio:1", {});
    advance(1);
    q.enqueue("transcribe", "transcribe:1", {}, { priority: PRIORITY.play });
    advance(1);
    q.enqueue("transcribe", "transcribe:2", {}, { priority: PRIORITY.snip });
    expect(q.claim(["render_clip"])).toBeNull();
    expect(q.claim(["transcribe", "fetch_audio"])!.key).toBe("transcribe:2");
    expect(q.claim(["transcribe", "fetch_audio"])!.key).toBe("transcribe:1");
    expect(q.claim(["transcribe", "fetch_audio"])!.key).toBe("fetch_audio:1");
    expect(q.claim(["transcribe", "fetch_audio"])).toBeNull();
  });

  it("reclaims an expired lease but not a live one", () => {
    const { q, advance } = queue();
    q.enqueue("transcribe", "transcribe:1", {});
    const first = q.claim(["transcribe"])!;
    expect(q.claim(["transcribe"])).toBeNull();
    advance(11 * 60 * 1000);
    const again = q.claim(["transcribe"])!;
    expect(again.id).toBe(first.id);
    expect(again.attempts).toBe(2);
  });

  it("retries with backoff, then fails after the attempt limit", () => {
    const { q, advance } = queue();
    const { id } = q.enqueue("transcribe", "transcribe:1", {});
    for (let i = 0; i < 4; i++) {
      expect(q.claim(["transcribe"])).not.toBeNull();
      q.fail(id, `boom ${i}`);
      expect(q.get(id)!.status).toBe("queued");
      expect(q.claim(["transcribe"])).toBeNull(); // run_after is in the future
      advance(2 * 60 * 60 * 1000);
    }
    expect(q.claim(["transcribe"])).not.toBeNull();
    q.fail(id, "final");
    expect(q.get(id)!.status).toBe("failed");
    expect(q.get(id)!.last_error).toBe("final");
  });

  it("fails immediately when not retryable and re-queues a failed job on enqueue", () => {
    const { q } = queue();
    const { id } = q.enqueue("transcribe", "transcribe:1", {});
    q.claim(["transcribe"]);
    q.fail(id, "bad input", { retryable: false });
    expect(q.get(id)!.status).toBe("failed");
    q.enqueue("transcribe", "transcribe:1", { again: true });
    expect(q.get(id)).toMatchObject({ status: "queued", attempts: 0, payload: { again: true } });
  });

  it("re-runs a finished recurring job only when asked to", () => {
    const { q } = queue();
    const { id } = q.enqueue("refresh_feed", "refresh_feed:f1", { feed_id: "f1" });
    q.claim(["refresh_feed"]);
    q.complete(id);
    expect(q.enqueue("refresh_feed", "refresh_feed:f1", { feed_id: "f1" }).created).toBe(false);
    expect(q.get(id)!.status).toBe("done"); // without rerun, done stays done (one-shot semantics)
    const again = q.enqueue("refresh_feed", "refresh_feed:f1", { feed_id: "f1", scheduled: true }, { rerun: true });
    expect(again).toEqual({ id, created: false });
    expect(q.get(id)).toMatchObject({ status: "queued", attempts: 0, payload: { feed_id: "f1", scheduled: true } });
    expect(q.claim(["refresh_feed"])!.id).toBe(id);
    // a queued or running job is never duplicated or reset by a rerun request
    q.enqueue("refresh_feed", "refresh_feed:f1", { feed_id: "f1" }, { rerun: true });
    expect(q.get(id)!.status).toBe("running");
  });

  it("defers and wakes by key", () => {
    const { q } = queue();
    const { id } = q.enqueue("select_snip", "select_snip:r1", {});
    q.claim(["select_snip"]);
    q.defer(id, "waiting for transcript");
    expect(q.claim(["select_snip"])).toBeNull();
    expect(q.wake("select_snip:r1")).toBe(true);
    expect(q.claim(["select_snip"])!.id).toBe(id);
  });

  it("completes and counts", () => {
    const { q } = queue();
    const { id } = q.enqueue("transcribe", "transcribe:1", {});
    q.enqueue("transcribe", "transcribe:2", {});
    q.claim(["transcribe"]);
    q.complete(id);
    expect(q.counts()).toMatchObject({ done: 1, queued: 1 });
  });
});
