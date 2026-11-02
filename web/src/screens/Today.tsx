import { useState } from "react";
import { api, unwrap } from "../api/client";
import type { Feed } from "../api/types";
import { Artwork } from "../components/Artwork";
import { EpisodeRow } from "../components/EpisodeRow";
import { Icon } from "../components/Icon";
import { useSettings } from "../components/SettingsSheet";
import { navigate } from "../lib/router";
import { ago, clock, longDate, relativeDay } from "../lib/time";
import { useEpisodes } from "../lib/useEpisodes";
import { readJson, writeJson } from "../lib/storage";
import { useQuery } from "../lib/useQuery";
import { useEngine } from "../player/PlayerContext";

/** All, podcasts, or videos: a choice kept between visits, shared by Today and the Library. */
export type MediaFilterKind = "all" | "audio" | "video";
const FILTER_KEY = "pp.mediaFilter";
export function useMediaFilter(): [MediaFilterKind, (k: MediaFilterKind) => void] {
  const [kind, set] = useState<MediaFilterKind>(() => readJson<MediaFilterKind>(FILTER_KEY, "all"));
  return [kind, (k) => { writeJson(FILTER_KEY, k); set(k); }];
}
export function showsKind(filter: MediaFilterKind, kind: "audio" | "video"): boolean {
  return filter === "all" || filter === kind;
}
export function MediaFilter({ value, onChange }: { value: MediaFilterKind; onChange: (k: MediaFilterKind) => void }) {
  const choice = (k: MediaFilterKind, label: string) => (
    <button role="tab" aria-pressed={value === k} aria-selected={value === k} onClick={() => onChange(k)}>{label}</button>
  );
  return (
    <div className="seg seg--chips" role="tablist" aria-label="Podcasts or videos">
      {choice("all", "All")}
      {choice("audio", "Podcasts")}
      {choice("video", "Videos")}
    </div>
  );
}

export function useFeeds() {
  return useQuery<Feed[]>("feeds", () => unwrap(api.GET("/v1/feeds")));
}

export function feedArtwork(feeds: Feed[] | undefined, feedId: string): string | null {
  return feeds?.find((f) => f.id === feedId)?.image_url ?? null;
}

export function Today() {
  const feeds = useFeeds();
  const episodes = useEpisodes(null, 30);
  const engine = useEngine();
  const { open: openSettings } = useSettings();

  const inProgress = episodes.items
    .filter((e) => e.resume && !e.resume.finished && e.resume.position_ms > 0)
    .sort((a, b) => (b.resume?.updated_at ?? 0) - (a.resume?.updated_at ?? 0));
  const current = inProgress[0];
  // The server lists an unfollowed show's episode only while it is in progress, for Continue listening; it is not news.
  const unfollowed = new Set((feeds.data ?? []).filter((f) => !f.followed).map((f) => f.id));
  const [kind, setKind] = useMediaFilter();
  const fresh = episodes.items.filter((e) => e.id !== current?.id && !unfollowed.has(e.feed_id) && showsKind(kind, e.media_kind)).slice(0, 15);
  const refreshedAt = feeds.data ? Math.max(0, ...feeds.data.map((f) => f.last_refresh_at ?? 0)) : 0;

  return (
    <div className="screen screen--with-mini">
      <header className="page-head">
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <div className="page-head__eyebrow">{longDate()}</div>
          <h1>Today</h1>
        </div>
        <div className="page-head__actions">
          <button className="icon-btn" onClick={(e) => openSettings(e.currentTarget)} aria-label="Profile and settings">
            <span className="avatar" aria-hidden="true"><Icon name="user" size={22} /></span>
          </button>
        </div>
      </header>

      {current && current.resume && (
        <section className="section" aria-labelledby="cont-h">
          <h2 id="cont-h">Continue listening</h2>
          <div className="card card--continue card--link">
            {/* The whole card opens the player; Resume (above this link) also starts playback. */}
            <a
              className="card__cover"
              href={`/episodes/${current.id}`}
              aria-label={`Open ${current.title}`}
              onClick={(e) => {
                e.preventDefault();
                void engine.open(current.id);
                navigate(`/episodes/${current.id}`);
              }}
            />
            <div className="row-art">
              <Artwork src={current.image_url ?? feedArtwork(feeds.data, current.feed_id)} size={68} radius={12} alt="" />
              <div className="row-art__body">
                <div className="card__meta">
                  {feeds.data?.find((f) => f.id === current.feed_id)?.is_private && <Icon name="lock" size={15} strokeWidth={2.2} />}
                  <span>
                    {[current.show_title, relativeDay(current.published_at)].filter(Boolean).join(" · ")}
                  </span>
                </div>
                <div className="card__sub tnum">
                  {clock(current.resume.position_ms)}
                  {current.duration_ms ? ` of ${clock(current.duration_ms)}` : ""}
                </div>
              </div>
            </div>
            <div className="card__title">{current.title}</div>
            {current.duration_ms ? (
              <div className="progress-row">
                <div className="progress" role="img" aria-label={`${Math.round((current.resume.position_ms / current.duration_ms) * 100)} percent played`}>
                  <div className="progress__fill" style={{ width: `${Math.min(100, (current.resume.position_ms / current.duration_ms) * 100)}%` }} />
                </div>
                <span className="tnum">{clock(current.duration_ms - current.resume.position_ms)} left</span>
              </div>
            ) : null}
            <div className="btn-row">
              <button
                className="btn btn--accent"
                onClick={() => {
                  void engine.open(current.id, { autoplay: true });
                  navigate(`/episodes/${current.id}`);
                }}
              >
                <Icon name="play" size={20} />
                Resume
              </button>
            </div>
          </div>
        </section>
      )}

      <section className="section" aria-labelledby="new-h">
        <div className="section__head">
          <h2 id="new-h">New episodes</h2>
          {refreshedAt > 0 && <span className="section__meta">Refreshed {ago(refreshedAt)}</span>}
        </div>
        <MediaFilter value={kind} onChange={setKind} />
        {episodes.error && <p className="error">{episodes.error}</p>}
        {episodes.loading && fresh.length === 0 && <p className="empty">Loading…</p>}
        {!episodes.loading && fresh.length === 0 && !episodes.error && <p className="empty">No episodes yet. Subscribe to a feed from the server to get started.</p>}
        <ul className="list">
          {fresh.map((e) => (
            <EpisodeRow key={e.id} episode={e} artwork={feedArtwork(feeds.data, e.feed_id)} showTitle />
          ))}
        </ul>
      </section>
    </div>
  );
}
