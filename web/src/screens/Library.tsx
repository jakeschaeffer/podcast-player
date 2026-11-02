import { Artwork } from "../components/Artwork";
import { Icon } from "../components/Icon";
import { useSettings } from "../components/SettingsSheet";
import { useDesktop } from "../lib/layout";
import { navigate, onLinkClick } from "../lib/router";
import { ago } from "../lib/time";
import { MediaFilter, showsKind, useFeeds, useMediaFilter } from "./Today";

export function Library() {
  const feeds = useFeeds();
  const { open: openSettings } = useSettings();
  const desktop = useDesktop();
  // A show opened from the native app's search without following it is not in the library.
  const [kind, setKind] = useMediaFilter();
  // Pasted links holds videos and audio alike, so it stays under either filter.
  const shows = (feeds.data ?? []).filter((f) => (f.kind === "podcast" || f.kind === "youtube" || f.kind === "links") && f.followed && (f.kind === "links" || showsKind(kind, f.kind === "youtube" ? "video" : "audio")));
  const textFor = new Set((feeds.data ?? []).filter((f) => f.kind === "text").map((f) => f.text_for_feed_id));

  return (
    <div className="screen screen--with-mini">
      <header className="page-head">
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <div className="page-head__eyebrow">{shows.length === 1 ? "1 show" : `${shows.length} shows`}</div>
          <h1>Library</h1>
        </div>
        <div className="page-head__actions">
          {desktop ? (
            <button className="btn btn--soft" style={{ marginRight: 8 }} onClick={() => navigate("/library/add")}>
              <Icon name="search" size={20} />
              Add a show
            </button>
          ) : (
            <button className="icon-btn" onClick={() => navigate("/library/add")} aria-label="Add a show">
              <Icon name="search" size={24} />
            </button>
          )}
          <button className="icon-btn" onClick={(e) => openSettings(e.currentTarget)} aria-label="Profile and settings">
            <span className="avatar" aria-hidden="true"><Icon name="user" size={22} /></span>
          </button>
        </div>
      </header>
      <section className="section" aria-label="Shows">
        <MediaFilter value={kind} onChange={setKind} />
        {feeds.error && <p className="error">{feeds.error}</p>}
        {feeds.loading && shows.length === 0 && <p className="empty">Loading…</p>}
        {!feeds.loading && shows.length === 0 && !feeds.error && (
          <div className="empty">
            <p>No shows yet.</p>
            <a className="btn btn--accent" style={{ marginTop: 14 }} href="/library/add" onClick={onLinkClick}>Add a show</a>
          </div>
        )}
        {/* Desktop: a grid of covers, the way a library reads on a big screen. */}
        {desktop && (
          <ul className="show-grid">
            {shows.map((f) => (
              <li key={f.id}>
                <a className="show-tile" href={`/library/${f.id}`} onClick={onLinkClick}>
                  <Artwork src={f.image_url} size="100%" radius={14} />
                  <span className="show-tile__title">{f.title ?? "Untitled show"}</span>
                  <span className="show-tile__meta">
                    {f.is_private && <Icon name="lock" size={15} strokeWidth={2.2} label="Private feed" />}
                    <span>{[f.episode_count === 1 ? "1 episode" : `${f.episode_count} episodes`, f.kind === "youtube" ? "YouTube" : f.kind === "links" ? "One-offs" : null, textFor.has(f.id) ? "Publisher text" : null, f.auto_process ? null : "Manual"].filter(Boolean).join(" · ")}</span>
                  </span>
                  {f.last_error && <span className="error" style={{ fontSize: 15 }}>{f.last_error}</span>}
                </a>
              </li>
            ))}
          </ul>
        )}
        {!desktop && (
        <ul className="list">
          {shows.map((f) => (
            <li key={f.id} className="list-item">
              <a className="list-item__link" href={`/library/${f.id}`} onClick={onLinkClick}>
                <Artwork src={f.image_url} size={60} radius={10} />
                <div className="list-item__body">
                  <div className="list-item__title">{f.title ?? "Untitled show"}</div>
                  <div className="list-item__meta">
                    {f.is_private && <Icon name="lock" size={15} strokeWidth={2.2} label="Private feed" />}
                    <span>{[f.episode_count === 1 ? "1 episode" : `${f.episode_count} episodes`, f.kind === "youtube" ? "YouTube" : f.kind === "links" ? "One-offs" : null, textFor.has(f.id) ? "Publisher text" : null, f.auto_process ? null : "Manual"].filter(Boolean).join(" · ")}</span>
                  </div>
                  {f.last_error && <div className="error" style={{ fontSize: 15 }}>{f.last_error}</div>}
                </div>
                <span className="icon-btn" aria-hidden="true">
                  <Icon name="chevronRight" size={22} />
                </span>
              </a>
            </li>
          ))}
        </ul>
        )}
        {feeds.data && feeds.data.length > 0 && <p className="section__meta">Last refresh {ago(Math.max(0, ...feeds.data.map((f) => f.last_refresh_at ?? 0)))}</p>}
      </section>
    </div>
  );
}
