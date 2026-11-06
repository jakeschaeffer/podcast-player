import { Artwork } from "../components/Artwork";
import { Icon } from "../components/Icon";
import type { EpisodeDetail } from "../api/types";
import { back } from "../lib/router";

function length(ms: number | null | undefined): string | null {
  if (!ms) return null;
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `${Math.max(1, minutes)} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/**
 * A channel's video that has not been fetched: what is known about it, at once, and Fetch, the one thing here that
 * starts the download. The description is the server's sanitized HTML (lib/sanitize.ts on the server).
 */
export function VideoDetails({ episode, artwork, onFetch }: { episode: EpisodeDetail; artwork: string | null; onFetch: () => Promise<void> }) {
  const status = episode.video.status;
  const date = episode.published_at ? new Date(episode.published_at).toLocaleDateString(undefined, { dateStyle: "medium" }) : null;
  const chapters = episode.chapters?.items ?? [];
  return (
    <div className="screen video-details">
      <header className="page-head">
        <button className="icon-btn" style={{ marginLeft: -12 }} onClick={() => back("/")} aria-label="Back">
          <Icon name="chevronLeft" size={27} strokeWidth={2.1} />
        </button>
      </header>
      <Artwork src={episode.image_url ?? artwork} size={120} radius={14} className="video-details__art" />
      <h1 className="video-details__title">{episode.title}</h1>
      <div className="card__meta">{[episode.show_title, date, length(episode.duration_ms)].filter(Boolean).join(" · ")}</div>
      <div className="video-details__fetch" role="status">
        {status === "requested" ? (
          <p className="empty">Fetching the video… The home fetcher brings it; a long one takes a few minutes.</p>
        ) : (
          <>
            {status === "failed" && <p className="error">The video could not be fetched: {episode.video.error ?? "unknown error"}</p>}
            <button className="btn btn--accent" onClick={() => void onFetch()}>
              <Icon name="video" size={22} />
              {status === "failed" ? "Try again" : "Fetch"}
            </button>
          </>
        )}
      </div>
      {episode.description_html ? (
        <div className="video-details__notes" dangerouslySetInnerHTML={{ __html: episode.description_html }} />
      ) : (
        <p className="empty">No description yet.</p>
      )}
      {chapters.length > 0 && (
        <section aria-label="Chapters">
          <h2 className="video-details__heading">Chapters</h2>
          <ol className="video-details__chapters">
            {chapters.map((c) => (
              <li key={c.start_ms}>{c.title}</li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
