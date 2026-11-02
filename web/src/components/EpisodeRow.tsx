import { describeError } from "../api/client";
import type { EpisodeListItem } from "../api/types";
import { navigate } from "../lib/router";
import { clock, minutes, relativeDay } from "../lib/time";
import { useEngine } from "../player/PlayerContext";
import { addToQueue } from "../player/queue";
import { Artwork } from "./Artwork";
import { Icon } from "./Icon";
import { ProcessingState } from "./ProcessingState";
import { useToast } from "./Toast";

export function EpisodeRow({ episode, artwork, showTitle }: { episode: EpisodeListItem; artwork: string | null; showTitle?: boolean }) {
  const engine = useEngine();
  const resume = episode.resume && !episode.resume.finished && episode.resume.position_ms > 0 ? episode.resume : null;
  const finished = episode.resume?.finished ?? false;
  const meta = [showTitle ? episode.show_title : null, relativeDay(episode.published_at), minutes(episode.duration_ms)].filter(Boolean).join(" · ");
  const toast = useToast();
  const add = async () => {
    try {
      await addToQueue(episode.id);
      toast("Added to Up next");
    } catch (e) {
      toast(describeError(e));
    }
  };
  const open = (autoplay: boolean) => {
    void engine.open(episode.id, { autoplay });
    navigate(`/episodes/${episode.id}`);
  };
  return (
    <li className="list-item">
      <a className="list-item__link" href={`/episodes/${episode.id}`} onClick={(e) => { e.preventDefault(); open(false); }}>
        <Artwork src={episode.image_url ?? artwork} size={60} radius={10} />
        <div className="list-item__body">
          <div className="list-item__title">{episode.title}</div>
          <div className="list-item__meta">
            <span>{meta}</span>
            {(episode.media_kind === "video" || episode.video.status === "ready") && (
              <span className="state state--video">
                <Icon name="video" size={16} strokeWidth={2.2} />
                Video
              </span>
            )}
            <ProcessingState processing={episode.processing} />
            {finished && (
              <span className="state state--pending">
                <Icon name="check" size={16} strokeWidth={2.2} />
                Played
              </span>
            )}
          </div>
          {resume && episode.duration_ms ? (
            <div className="progress-row">
              <div className="progress" role="img" aria-label={`${Math.round((resume.position_ms / episode.duration_ms) * 100)} percent played`}>
                <div className="progress__fill" style={{ width: `${Math.min(100, (resume.position_ms / episode.duration_ms) * 100)}%` }} />
              </div>
              <span className="tnum">{clock(episode.duration_ms - resume.position_ms)} left</span>
            </div>
          ) : null}
        </div>
      </a>
      <button className="icon-btn" onClick={() => void add()} aria-label={`Add ${episode.title} to Up next`} title="Add to Up next">
        <Icon name="queueAdd" size={22} />
      </button>
      <button className="icon-btn icon-btn--ring" onClick={() => open(true)} aria-label={`${resume ? "Resume" : "Play"} ${episode.title}`}>
        <Icon name="play" size={18} />
      </button>
    </li>
  );
}
