import { useEffect, useState } from "react";
import { Artwork } from "../components/Artwork";
import { EpisodeRow } from "../components/EpisodeRow";
import { Icon } from "../components/Icon";
import { useToast } from "../components/Toast";
import { ShowSettingsSheet } from "../library/ShowSettingsSheet";
import { useDesktop } from "../lib/layout";
import { back, navigate } from "../lib/router";
import { useEpisodes } from "../lib/useEpisodes";
import { invalidate } from "../lib/useQuery";
import { useFeeds } from "./Today";

/** How often to look again while a newly added show's first refresh is still running, and for how long. */
const FIRST_REFRESH_POLL_MS = 2_000;
const FIRST_REFRESH_GIVE_UP_MS = 90_000;

export function FeedEpisodes({ feedId }: { feedId: string }) {
  const feeds = useFeeds();
  const feed = feeds.data?.find((f) => f.id === feedId);
  const episodes = useEpisodes(feedId, 30);
  const [settings, setSettings] = useState(false);
  const toast = useToast();
  const desktop = useDesktop();
  // A show added a moment ago has not been fetched yet: its feed refresh is a queued job on the server.
  const fetching = feed !== undefined && feed.last_refresh_at === null && feed.last_error === null;
  const { reload: reloadFeeds } = feeds;
  const { reload: reloadEpisodes } = episodes;

  useEffect(() => {
    if (!fetching) return;
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - started > FIRST_REFRESH_GIVE_UP_MS) return window.clearInterval(timer);
      void reloadFeeds();
    }, FIRST_REFRESH_POLL_MS);
    return () => window.clearInterval(timer);
  }, [fetching, reloadFeeds]);
  useEffect(() => {
    if (feed?.last_refresh_at) void reloadEpisodes();
  }, [feed?.last_refresh_at, reloadEpisodes]);

  return (
    <div className="screen screen--with-mini">
      <header className="page-head show-head" style={{ alignItems: "center" }}>
        <button className="icon-btn" style={{ marginLeft: -12 }} onClick={() => back("/library")} aria-label="Back to Library">
          <Icon name={desktop ? "chevronLeft" : "chevronDown"} size={27} strokeWidth={2.1} />
        </button>
        <div className="row-art" style={{ flex: 1, minWidth: 0 }}>
          <Artwork src={feed?.image_url} size={desktop ? 112 : 56} radius={desktop ? 16 : 12} />
          <div className="row-art__body">
            <h1 className="show-head__title">{feed?.title ?? "Show"}</h1>
            <div className="card__meta">
              {feed?.is_private && <Icon name="lock" size={15} strokeWidth={2.2} label="Private feed" />}
              <span>{[feed?.author, feed && !feed.auto_process ? "Manual" : null].filter(Boolean).join(" · ")}</span>
            </div>
          </div>
        </div>
        {feed &&
          (desktop ? (
            <button className="btn btn--soft" onClick={() => setSettings(true)} aria-haspopup="dialog">
              <Icon name="more" size={20} />
              Show settings
            </button>
          ) : (
            <button className="icon-btn" style={{ marginRight: -8 }} onClick={() => setSettings(true)} aria-label="Show settings">
              <Icon name="more" size={24} />
            </button>
          ))}
      </header>
      <section className="section" aria-label="Episodes">
        {episodes.error && <p className="error">{episodes.error}</p>}
        {feed?.last_error && <p className="error">Couldn’t read this feed: {feed.last_error}. Check the address, or unsubscribe from {desktop ? "Show settings" : "the ⋯ menu"}.</p>}
        {fetching && episodes.items.length === 0 && <p className="empty">Fetching episodes…</p>}
        {!fetching && episodes.loading && episodes.items.length === 0 && <p className="empty">Loading…</p>}
        {!fetching && !episodes.loading && !episodes.error && episodes.items.length === 0 && feed?.last_refresh_at && !feed.last_error && <p className="empty">This feed has no episodes.</p>}
        <ul className="list">
          {episodes.items.map((e) => (
            <EpisodeRow key={e.id} episode={e} artwork={feed?.image_url ?? null} />
          ))}
        </ul>
        {episodes.next && (
          <button className="btn btn--soft load-more" onClick={() => void episodes.loadMore()} disabled={episodes.more}>
            {episodes.more ? "Loading…" : "Load more"}
          </button>
        )}
      </section>
      {settings && feed && (
        <ShowSettingsSheet
          feed={feed}
          onClose={() => setSettings(false)}
          onChanged={(next) => feeds.mutate((prev) => (prev ?? []).map((f) => (f.id === next.id ? next : f)))}
          onRemoved={() => {
            invalidate("feeds");
            toast(`Removed ${feed.title ?? "the show"}`);
            navigate("/library", { replace: true });
          }}
        />
      )}
    </div>
  );
}
