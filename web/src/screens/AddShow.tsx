import { useEffect, useRef, useState } from "react";
import { api, describeError, unwrap } from "../api/client";
import type { Feed, ShowSearchPage } from "../api/types";
import { Artwork } from "../components/Artwork";
import { Icon } from "../components/Icon";
import { useToast } from "../components/Toast";
import { SubscribeSheet, type SubscribeTarget } from "../library/SubscribeSheet";
import { classifyLink } from "../lib/links";
import { back, navigate } from "../lib/router";
import { useEngine } from "../player/PlayerContext";
import { invalidate, useQuery } from "../lib/useQuery";

/**
 * Find a show and subscribe to it. Typing searches the public directory (Apple Podcasts, or Podcast Index when the
 * server has its keys); pasting a feed address subscribes to that address directly, which is how private feeds are
 * added. A YouTube channel link (or a bare @handle) subscribes to the channel; a YouTube video link makes the video an
 * episode of its channel's show and opens it in the player; a link to a video or audio file becomes a one-off episode
 * of the Pasted links show, downloaded and transcribed by the server (lib/links.ts tells them apart). Results the
 * library already has open their show instead of offering to subscribe.
 */
export function AddShow() {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [target, setTarget] = useState<SubscribeTarget | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const engine = useEngine();
  /** The link being sent to the server, while it is. */
  const [adding, setAdding] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(q.trim()), 400);
    return () => window.clearTimeout(t);
  }, [q]);

  const link = classifyLink(debounced);
  const feedUrl = link?.kind === "feed" || link?.kind === "youtube-channel" ? link.url : null;
  const searchable = !link && debounced.length >= 2;
  const results = useQuery<ShowSearchPage>(searchable ? `shows:${debounced}` : null, () =>
    unwrap(api.GET("/v1/search/shows", { params: { query: { q: debounced, limit: 20 } } })),
  );

  function subscribed(feed: Feed) {
    setTarget(null);
    invalidate("feeds");
    invalidate("shows:");
    toast(`Subscribed to ${feed.title ?? "the show"}`);
    navigate(`/library/${feed.id}`, { replace: true });
  }

  /** A pasted video: an episode on the server, which fetches its file; the player opens on it meanwhile. */
  async function addVideo(url: string, kind: "youtube-video" | "media") {
    setAdding(url);
    setAddError(null);
    try {
      const episode = await unwrap(kind === "youtube-video" ? api.POST("/v1/youtube/episodes", { body: { url } }) : api.POST("/v1/links/episodes", { body: { url } }));
      invalidate("feeds");
      invalidate("episodes");
      void engine.open(episode.id);
      navigate(`/episodes/${episode.id}`);
    } catch (e) {
      setAddError(describeError(e));
      setAdding(null);
    }
  }

  const items = searchable ? (results.data?.results ?? []) : [];
  return (
    <div className="screen screen--with-mini">
      <header className="page-head page-head--sub">
        <button className="icon-btn page-head__back" onClick={() => back("/library")} aria-label="Back to Library">
          <Icon name="chevronDown" size={27} strokeWidth={2.1} />
        </button>
        <h1 style={{ fontSize: 26 }}>Add a show</h1>
      </header>
      <label className="search">
        <Icon name="search" size={22} />
        <input
          ref={input}
          type="search"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="Search shows, or paste a feed, YouTube or video link"
          aria-label="Search shows, or paste a feed, YouTube or video link"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {q && (
          <button className="icon-btn" style={{ width: 36, height: 36, marginRight: -8 }} onClick={() => { setQ(""); input.current?.focus(); }} aria-label="Clear search">
            <Icon name="close" size={18} />
          </button>
        )}
      </label>

      <section className="section" aria-label="Results">
        {link?.kind === "youtube-video" && (
          <div className="card">
            <div className="card__meta"><Icon name="video" size={16} />YouTube video</div>
            <div className="card__title" style={{ overflowWrap: "anywhere", fontSize: 17 }}>{link.url}</div>
            <p className="section__meta">The video becomes an episode of its channel's show and is fetched at home; it opens in the player while that happens. The channel is not followed unless you follow it.</p>
            {addError && <p className="error" role="alert">{addError}</p>}
            <button className="btn btn--accent" onClick={() => void addVideo(link.url, "youtube-video")} disabled={adding !== null}>
              {adding === link.url ? "Opening…" : "Open this video"}
            </button>
          </div>
        )}
        {link?.kind === "media" && (
          <div className="card">
            <div className="card__meta"><Icon name="video" size={16} />Video link</div>
            <div className="card__title" style={{ overflowWrap: "anywhere", fontSize: 17 }}>{link.url}</div>
            <p className="section__meta">The file becomes a one-off episode of Pasted links: the server downloads it and transcribes it, and it opens in the player meanwhile. A link to a web page (an X post, say) won't do; paste the video file's own address.</p>
            {addError && <p className="error" role="alert">{addError}</p>}
            <button className="btn btn--accent" onClick={() => void addVideo(link.url, "media")} disabled={adding !== null}>
              {adding === link.url ? "Adding…" : "Add this video"}
            </button>
          </div>
        )}
        {feedUrl && (
          <div className="card">
            <div className="card__meta"><Icon name="link" size={16} />{link?.kind === "youtube-channel" ? "YouTube channel" : "Feed address"}</div>
            <div className="card__title" style={{ overflowWrap: "anywhere", fontSize: 17 }}>{feedUrl}</div>
            <p className="section__meta">
              {link?.kind === "youtube-channel"
                ? "The channel's latest videos become episodes, fetched at home when you ask for one."
                : "Private feeds carry their access key in the address. It is stored encrypted and never shown again."}
            </p>
            {addError && <p className="error" role="alert">{addError}</p>}
            <div className="btn-row">
              <button className="btn btn--accent" onClick={() => setTarget({ title: new URL(feedUrl).hostname, author: null, artwork_url: null, feed_url: feedUrl })} disabled={adding !== null}>
                {link?.kind === "youtube-channel" ? "Subscribe to this channel" : "Subscribe to this feed"}
              </button>
              {link?.kind === "feed" && (
                <button className="btn btn--soft" onClick={() => void addVideo(feedUrl, "media")} disabled={adding !== null}>
                  {adding === feedUrl ? "Adding…" : "Not a feed? Add it as a one-off video"}
                </button>
              )}
            </div>
          </div>
        )}
        {!link && debounced.length < 2 && <p className="empty">Find a show by name, or paste the address of its RSS feed, a YouTube channel or video, or a video file.</p>}
        {results.error && searchable && <p className="error">{results.error}</p>}
        {results.loading && searchable && items.length === 0 && <p className="empty">Searching…</p>}
        {searchable && results.data && items.length === 0 && <p className="empty">No shows match “{debounced}”.</p>}
        <ul className="list">
          {items.map((r) => (
            <li key={r.feed_url} className="list-item">
              <Artwork src={r.artwork_url} size={60} radius={10} />
              <div className="list-item__body">
                <div className="list-item__title">{r.title}</div>
                <div className="list-item__meta">
                  <span>{[r.author, r.episode_count !== null ? (r.episode_count === 1 ? "1 episode" : `${r.episode_count} episodes`) : null, r.genres[0]].filter(Boolean).join(" · ")}</span>
                </div>
              </div>
              {r.feed_id ? (
                <a className="btn btn--soft" href={`/library/${r.feed_id}`} onClick={(e) => { e.preventDefault(); navigate(`/library/${r.feed_id}`); }}>
                  Open
                </a>
              ) : (
                <button className="btn btn--soft" onClick={() => setTarget({ title: r.title, author: r.author, artwork_url: r.artwork_url, feed_url: r.feed_url })} aria-label={`Subscribe to ${r.title}`}>
                  Add
                </button>
              )}
            </li>
          ))}
        </ul>
        {searchable && results.data && items.length > 0 && <p className="section__meta">Results from {results.data.source === "podcastindex" ? "Podcast Index" : "Apple Podcasts"}</p>}
      </section>

      {target && <SubscribeSheet target={target} onClose={() => setTarget(null)} onSubscribed={subscribed} />}
    </div>
  );
}
