import { useState } from "react";
import { api, describeError, unwrap } from "../api/client";
import type { EpisodeShare as Share, Snip, SnipPage } from "../api/types";
import { Icon } from "../components/Icon";
import { Sheet } from "../components/Sheet";
import { useToast } from "../components/Toast";
import { copyPending, shareLink } from "../lib/clipboard";
import { clock, relativeDay, spanLength } from "../lib/time";
import { invalidate, useQuery } from "../lib/useQuery";
import { clipPlayer, usePlayingClip } from "./clipPlayer";
import { isPending } from "./useSnip";

type EpisodeShare = Share | null;

/**
 * Every snip from one episode, in episode order. Choosing one opens its card; the play button plays just that
 * snip's clip. The episode's playhead never moves: it pauses for the clip and picks up where it was afterwards.
 * Mounted only while open, so each opening refreshes the list; closing it stops a clip that is playing.
 *
 * "Share all" publishes one page with every shared snip of the episode (`/e/{token}`), playable one after another
 * and each shareable on its own. The page reads the snips when it is opened, so later snips appear on it too.
 */
export function EpisodeSnips({ episodeId, episodeTitle, onClose, onOpen }: { episodeId: string; episodeTitle: string; onClose: () => void; onOpen: (s: Snip) => void }) {
  const playing = usePlayingClip();
  const toast = useToast();
  const shareKey = `share:episode:${episodeId}`;
  const share = useQuery<EpisodeShare>(shareKey, () => unwrap(api.GET("/v1/episodes/{id}/share", { params: { path: { id: episodeId } }, cache: "no-store" })) as Promise<EpisodeShare>);
  const [shareState, setShareState] = useState<EpisodeShare | undefined>(undefined);
  const current = shareState !== undefined ? shareState : share.data;
  const [busy, setBusy] = useState(false);
  const pageTitle = `Snips from ${episodeTitle}`;
  // Public pages live on the app's own host, so the link is built on the address the app is open at. The server's
  // PUBLIC_BASE_URL can be a loopback address in development, which another device could not open.
  const linkFor = (shareUrl: string) => new URL(new URL(shareUrl).pathname, location.origin).href;

  const publish = async (): Promise<NonNullable<EpisodeShare>> => {
    const s = await unwrap(api.POST("/v1/episodes/{id}/share", { params: { path: { id: episodeId } } }));
    invalidate(shareKey);
    setShareState(s);
    return s;
  };
  // Straight from the tap (see shareLink): an active link goes to the share sheet; a new one is created and copied.
  const shareAll = async () => {
    if (busy) return;
    try {
      if (current?.state === "active") {
        const how = await shareLink(linkFor(current.share_url), pageTitle);
        if (how === "copied") toast("Link to all snips copied");
        return;
      }
      setBusy(true);
      const how = await copyPending(publish().then((s) => linkFor(s.share_url)));
      if (how === "copied") toast("Link to all snips copied");
    } catch (e) {
      toast(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  const stopSharing = async () => {
    setBusy(true);
    try {
      const s = await unwrap(api.POST("/v1/episodes/{id}/share/revoke", { params: { path: { id: episodeId } } }));
      invalidate(shareKey);
      setShareState(s);
      toast("Page withdrawn");
    } catch (e) {
      toast(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    clipPlayer.stop();
    onClose();
  };
  const page = useQuery<SnipPage>(`snips:episode:${episodeId}`, () =>
    unwrap(api.GET("/v1/snips", { params: { query: { episode_id: episodeId, limit: 200 } }, cache: "no-store" })),
  );
  const items = [...(page.data?.items ?? [])].sort((a, b) => (a.revision?.start_ms ?? a.anchor_ms) - (b.revision?.start_ms ?? b.anchor_ms));

  return (
    <Sheet onClose={close} label="Snips from this episode" dock>
      <div className="episode-snips">
        <div className="episode-snips__top">
          <h2 className="episode-snips__head">
            Snips
            {page.data && <span className="episode-snips__count tnum">{items.length}</span>}
          </h2>
          <button className="btn btn--soft episode-snips__share" onClick={() => void shareAll()} disabled={busy || items.length === 0} aria-label="Share a page with all these snips">
            <Icon name="share" size={17} />
            Share all
          </button>
        </div>
        <div className="episode-snips__sharebar">
          {current?.state === "active" && (
            <p className="episode-snips__shared" aria-label={`Shared page with ${current.snip_count} ${current.snip_count === 1 ? "snip" : "snips"}`}>
              <Icon name="globe" size={16} />
              <a href={new URL(current.share_url).pathname} target="_blank" rel="noopener">Open</a>
              <button onClick={() => void stopSharing()} disabled={busy}>Stop sharing</button>
            </p>
          )}
          {current?.state === "revoked" && (
            <p className="episode-snips__shared">
              <Icon name="eyeOff" size={16} />
              <span>Page withdrawn</span>
            </p>
          )}
        </div>
        {page.error && <p className="error">{page.error}</p>}
        {page.loading && items.length === 0 && <p className="empty">Loading…</p>}
        {!page.loading && !page.error && items.length === 0 && <p className="empty">No snips from this episode yet.</p>}
        <ul className="episode-snips__list">
          {items.map((s) => {
            const r = s.revision;
            const isPlaying = !!r && playing === r.id;
            return (
              <li key={s.id} className="episode-snips__row">
                <button className="episode-snips__main" onClick={() => onOpen(s)}>
                  <span className="episode-snips__title">{r?.title ?? (isPending(s) ? "Choosing the moment…" : "Snip")}</span>
                  <span className="episode-snips__meta tnum">
                    {r ? `${clock(r.start_ms)} – ${clock(r.end_ms)} (${spanLength(r.end_ms - r.start_ms)})` : `at ${clock(s.anchor_ms)}`}
                    {` · ${relativeDay(s.created_at)}`}
                    {s.share_state === "revoked" ? " · link revoked" : ""}
                  </span>
                </button>
                <button
                  className="icon-btn episode-snips__play"
                  disabled={!r?.clip_url}
                  onClick={() => r?.clip_url && clipPlayer.toggle(r.id, r.clip_url)}
                  aria-pressed={isPlaying}
                  aria-label={isPlaying ? "Stop clip" : `Play clip, ${r ? spanLength(r.end_ms - r.start_ms) : ""}`}
                >
                  <Icon name={isPlaying ? "stop" : s.media_kind === "video" ? "video" : "play"} size={18} />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </Sheet>
  );
}
