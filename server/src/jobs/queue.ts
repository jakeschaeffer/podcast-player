import type { Db } from "../db/index.js";
import { newId } from "../lib/ids.js";

export type JobKind =
  | "refresh_feed"
  | "fetch_audio"
  | "fetch_video"
  | "prune_video"
  | "transcribe"
  | "summarize_episode"
  | "select_snip"
  | "render_clip"
  | "render_video_clip"
  | "summarize_snip"
  | "sync_email"
  | "align_text"
  | "detect_ads"
  | "eval_run"
  | "identify_speakers";

export type JobStatus = "queued" | "running" | "done" | "failed" | "deferred";

export type JobRow = {
  id: string;
  kind: JobKind;
  key: string;
  payload: string;
  priority: number;
  status: JobStatus;
  attempts: number;
  run_after: number;
  locked_until: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};

export type Job<P = unknown> = Omit<JobRow, "payload"> & { payload: P };

/** Priorities from docs/core/04-transcription.md. */
/** Above `catalog` is the owner's own request, which ignores the monthly transcription budget. */
export const PRIORITY = { snip: 100, play: 50, upNext: 25, catalog: 0 } as const;

const MAX_ATTEMPTS = 5;
const LEASE_MS = 10 * 60 * 1000;

/**
 * Durable jobs in SQLite. `key` makes enqueueing idempotent: a second enqueue of the same key
 * is a no-op except that a higher priority is adopted and a failed job is re-queued.
 */
export class JobQueue {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {}

  /**
   * `rerun` is for recurring work (feed refreshes, mail syncs): a job with the same key that already finished is
   * queued again instead of being treated as done forever. One-shot work (transcribe, render) leaves it off.
   */
  enqueue<P>(kind: JobKind, key: string, payload: P, opts: { priority?: number; runAfter?: number; rerun?: boolean } = {}): { id: string; created: boolean } {
    const t = this.now();
    const priority = opts.priority ?? PRIORITY.catalog;
    const runAfter = opts.runAfter ?? t;
    const existing = this.db.prepare("SELECT id, status, priority FROM job WHERE key = ?").get(key) as
      | Pick<JobRow, "id" | "status" | "priority">
      | undefined;
    if (existing) {
      if (existing.status === "failed" || existing.status === "deferred" || (opts.rerun === true && existing.status === "done")) {
        this.db
          .prepare("UPDATE job SET status = 'queued', payload = ?, priority = MAX(priority, ?), run_after = ?, attempts = 0, last_error = NULL, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(payload), priority, runAfter, t, existing.id);
      } else if (priority > existing.priority) {
        this.db.prepare("UPDATE job SET priority = ?, updated_at = ? WHERE id = ?").run(priority, t, existing.id);
      }
      return { id: existing.id, created: false };
    }
    const id = newId();
    this.db
      .prepare(
        "INSERT INTO job (id, kind, key, payload, priority, status, attempts, run_after, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)",
      )
      .run(id, kind, key, JSON.stringify(payload), priority, runAfter, t, t);
    return { id, created: true };
  }

  /** Claim the next runnable job of the given kinds. Expired leases are reclaimed. */
  claim(kinds: readonly JobKind[]): Job | null {
    if (kinds.length === 0) return null;
    const t = this.now();
    const placeholders = kinds.map(() => "?").join(",");
    const row = this.db
      .prepare(
        `UPDATE job SET status = 'running', locked_until = ?, attempts = attempts + 1, updated_at = ?
         WHERE id = (
           SELECT id FROM job
           WHERE kind IN (${placeholders}) AND run_after <= ?
             AND (status = 'queued' OR (status = 'running' AND locked_until < ?))
           ORDER BY priority DESC, created_at ASC LIMIT 1
         ) RETURNING *`,
      )
      .get(t + LEASE_MS, t, ...kinds, t, t) as JobRow | undefined;
    return row ? { ...row, payload: JSON.parse(row.payload) } : null;
  }

  heartbeat(id: string): void {
    this.db.prepare("UPDATE job SET locked_until = ? WHERE id = ? AND status = 'running'").run(this.now() + LEASE_MS, id);
  }

  complete(id: string): void {
    this.db.prepare("UPDATE job SET status = 'done', locked_until = NULL, last_error = NULL, updated_at = ? WHERE id = ?").run(this.now(), id);
  }

  /** Retry with bounded exponential backoff; after MAX_ATTEMPTS the job is failed and visible. */
  fail(id: string, error: string, opts: { retryable?: boolean } = {}): void {
    const t = this.now();
    const job = this.db.prepare("SELECT attempts FROM job WHERE id = ?").get(id) as { attempts: number } | undefined;
    if (!job) return;
    const retryable = opts.retryable ?? true;
    if (!retryable || job.attempts >= MAX_ATTEMPTS) {
      this.db.prepare("UPDATE job SET status = 'failed', locked_until = NULL, last_error = ?, updated_at = ? WHERE id = ?").run(error.slice(0, 2000), t, id);
      return;
    }
    const delay = Math.min(60 * 60 * 1000, 30_000 * 2 ** (job.attempts - 1));
    this.db
      .prepare("UPDATE job SET status = 'queued', locked_until = NULL, run_after = ?, last_error = ?, updated_at = ? WHERE id = ?")
      .run(t + delay, error.slice(0, 2000), t, id);
  }

  /** Park a job that must wait for something outside the queue (a transcript, a budget). `wake()` re-queues it. */
  defer(id: string, reason: string): void {
    this.db.prepare("UPDATE job SET status = 'deferred', locked_until = NULL, last_error = ?, updated_at = ? WHERE id = ?").run(reason, this.now(), id);
  }

  wake(key: string): boolean {
    const r = this.db.prepare("UPDATE job SET status = 'queued', run_after = ?, updated_at = ? WHERE key = ? AND status = 'deferred'").run(this.now(), this.now(), key);
    return r.changes > 0;
  }

  get(id: string): Job | null {
    const row = this.db.prepare("SELECT * FROM job WHERE id = ?").get(id) as JobRow | undefined;
    return row ? { ...row, payload: JSON.parse(row.payload) } : null;
  }

  byKey(key: string): Job | null {
    const row = this.db.prepare("SELECT * FROM job WHERE key = ?").get(key) as JobRow | undefined;
    return row ? { ...row, payload: JSON.parse(row.payload) } : null;
  }

  /** Jobs whose key mentions a subject id, for "preparing" indicators. */
  forSubject(subjectId: string): Job[] {
    const rows = this.db.prepare("SELECT * FROM job WHERE key LIKE ? ORDER BY created_at DESC LIMIT 50").all(`%${subjectId}%`) as JobRow[];
    return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
  }

  counts(): Record<JobStatus, number> {
    const rows = this.db.prepare("SELECT status, COUNT(*) AS n FROM job GROUP BY status").all() as { status: JobStatus; n: number }[];
    const out: Record<JobStatus, number> = { queued: 0, running: 0, done: 0, failed: 0, deferred: 0 };
    for (const r of rows) out[r.status] = r.n;
    return out;
  }
}
