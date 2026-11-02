import { api } from "../api/client";
import type { PlaybackBody } from "../api/types";
import { readJson, writeJson } from "../lib/storage";

/**
 * Playback reports: PUT /v1/playback/{asset_id} with a per-device `seq` that only ever grows.
 * Reports that cannot be sent wait in localStorage (latest per asset) and replay in seq order,
 * so a stale report can never overwrite a newer one and an offline stretch loses nothing.
 */
const SEQ_KEY = "pp.playback.seq";
const OUTBOX_KEY = "pp.playback.outbox";

type Entry = { asset_id: string; body: PlaybackBody; at: number };
let seq = readJson<number>(SEQ_KEY, 0);
let outbox = readJson<Record<string, Entry>>(OUTBOX_KEY, {});
let flushing = false;
let dirty = false;

function nextSeq(): number {
  seq += 1;
  writeJson(SEQ_KEY, seq);
  return seq;
}

export function reportPlayback(assetId: string, state: Omit<PlaybackBody, "seq">, opts: { keepalive?: boolean } = {}): void {
  outbox[assetId] = { asset_id: assetId, body: { ...state, seq: nextSeq() }, at: Date.now() };
  writeJson(OUTBOX_KEY, outbox);
  void flushPlayback(opts);
}

export async function flushPlayback(opts: { keepalive?: boolean } = {}): Promise<void> {
  if (flushing) {
    dirty = true;
    return;
  }
  flushing = true;
  try {
    do {
      dirty = false;
      const entries = Object.values(outbox).sort((a, b) => a.body.seq - b.body.seq);
      for (const e of entries) {
        try {
          const r = await api.PUT("/v1/playback/{asset_id}", { params: { path: { asset_id: e.asset_id } }, body: e.body, keepalive: opts.keepalive ?? false, cache: "no-store" });
          if (r.response.ok || (r.response.status >= 400 && r.response.status < 500 && r.response.status !== 401)) {
            // Delivered, or rejected for good (unknown asset, bad body): either way it will not get better by retrying.
            if (outbox[e.asset_id]?.body.seq === e.body.seq) delete outbox[e.asset_id];
          } else {
            break; // 401 (logged out) or 5xx: keep and retry later
          }
        } catch {
          break; // offline
        }
      }
      writeJson(OUTBOX_KEY, outbox);
    } while (dirty);
  } finally {
    flushing = false;
  }
}

window.addEventListener("online", () => void flushPlayback());
