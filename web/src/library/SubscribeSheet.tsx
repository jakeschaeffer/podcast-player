import { useState } from "react";
import { api, ApiError, describeError, unwrap } from "../api/client";
import type { Feed } from "../api/types";
import { Artwork } from "../components/Artwork";
import { Sheet } from "../components/Sheet";
import { ProcessingChoice } from "./ProcessingChoice";

/** How many of the newest episodes automatic mode may process right away, when the owner asks for it. */
const BACKFILL = 2;

export type SubscribeTarget = { title: string; author: string | null; artwork_url: string | null; feed_url: string };

/**
 * Confirm a subscription: the show, and whether it is processed automatically. Subscribing queues one free feed
 * refresh; with Automatic (and the backfill box ticked) the newest episodes are transcribed too, which is billed.
 */
export function SubscribeSheet({ target, onClose, onSubscribed }: { target: SubscribeTarget; onClose: () => void; onSubscribed: (feed: Feed) => void }) {
  const [automatic, setAutomatic] = useState(false);
  const [backfill, setBackfill] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function subscribe() {
    setSending(true);
    setError(null);
    try {
      const feed = await unwrap(api.POST("/v1/feeds", { body: { url: target.feed_url, auto_process: automatic, backfill: automatic && backfill ? BACKFILL : 0 } }));
      onSubscribed(feed);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409 ? "This show is already in your library." : describeError(e));
      setSending(false);
    }
  }

  return (
    <Sheet onClose={onClose} label={`Subscribe to ${target.title}`}>
      <div className="row-art">
        <Artwork src={target.artwork_url} size={64} radius={12} />
        <div className="row-art__body">
          <div className="sheet__title">{target.title}</div>
          {target.author && <div className="sheet__span">{target.author}</div>}
        </div>
      </div>
      <ProcessingChoice automatic={automatic} onChange={setAutomatic} />
      {automatic && (
        <label className="check">
          <input type="checkbox" checked={backfill} onChange={(e) => setBackfill(e.target.checked)} />
          <span>Also process the {BACKFILL} newest episodes now</span>
        </label>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <button className="btn btn--accent btn--block" onClick={() => void subscribe()} disabled={sending}>
        {sending ? "Subscribing…" : "Subscribe"}
      </button>
    </Sheet>
  );
}
