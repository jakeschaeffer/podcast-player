import { api, ApiError, unwrap } from "../api/client";
import type { CreateSnipBody, Snip } from "../api/types";
import { ulid } from "../lib/ids";
import { readJson, writeJson } from "../lib/storage";

/**
 * Snip taps are saved locally first and sent in order; `client_request_id` makes a resend harmless,
 * so a tap made offline (or while the server is restarting) is delivered when the connection returns.
 */
export interface PendingSnip extends CreateSnipBody {
  episode_id: string;
  created_at: number;
}
export type OutboxEvent = { type: "sent"; pending: PendingSnip; snip: Snip } | { type: "failed"; pending: PendingSnip; message: string } | { type: "queued"; pending: PendingSnip };

const KEY = "pp.snips.outbox";
let queue = readJson<PendingSnip[]>(KEY, []);
const listeners = new Set<(e: OutboxEvent) => void>();
let flushing = false;

function save() {
  writeJson(KEY, queue);
}
function emit(e: OutboxEvent) {
  for (const l of listeners) l(e);
}

export const snipOutbox = {
  pending: (): PendingSnip[] => queue,
  subscribe(l: (e: OutboxEvent) => void) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
  /** Queue a tap and try to send it now. Resolves with the snip when the server answered, null when it waits. */
  async capture(fields: { asset_id: string; anchor_ms: number; heard_from_ms: number; episode_id: string }): Promise<Snip | null> {
    const pending: PendingSnip = { client_request_id: ulid(), created_at: Date.now(), ...fields };
    queue = [...queue, pending];
    save();
    emit({ type: "queued", pending });
    return (await flush()).get(pending.client_request_id) ?? null;
  },
  flush,
};

async function flush(): Promise<Map<string, Snip>> {
  const sent = new Map<string, Snip>();
  if (flushing) return sent;
  flushing = true;
  try {
    while (queue.length > 0) {
      const p = queue[0]!;
      try {
        const snip = await unwrap(api.POST("/v1/snips", { body: { client_request_id: p.client_request_id, asset_id: p.asset_id, anchor_ms: p.anchor_ms, heard_from_ms: p.heard_from_ms } }));
        queue = queue.slice(1);
        save();
        sent.set(p.client_request_id, snip);
        emit({ type: "sent", pending: p, snip });
      } catch (e) {
        if (e instanceof ApiError && !e.isNetwork && e.status !== 401 && e.status < 500) {
          // The server rejected this tap for good (asset gone, bad fields): drop it and say so.
          queue = queue.slice(1);
          save();
          emit({ type: "failed", pending: p, message: e.message });
          continue;
        }
        break; // offline, logged out, or server trouble: keep the queue for later
      }
    }
  } finally {
    flushing = false;
  }
  return sent;
}

window.addEventListener("online", () => void flush());
