import { navigate } from "../lib/router";
import { useEngine, usePlayer } from "../player/PlayerContext";
import { AdSkip } from "../player/AdSkip";
import { Artwork } from "./Artwork";
import { Icon } from "./Icon";

export function MiniPlayer() {
  const p = usePlayer();
  const engine = useEngine();
  if (!p.episode) return null;
  const pct = p.durationMs > 0 ? Math.min(100, (p.positionMs / p.durationMs) * 100) : 0;
  const status = p.status === "details" ? (p.episode.video.status === "requested" ? "Fetching the video" : "Not fetched yet") : p.status === "preparing" ? "Preparing recording" : p.status === "loading" ? "Loading" : p.status === "error" ? p.error : p.episode.show_title;
  return (
    <div className="mini" style={{ position: "relative" }}>
      <div className="mini__bar" aria-hidden="true">
        <i style={{ width: `${pct}%` }} />
      </div>
      <button className="mini__open" onClick={() => navigate(`/episodes/${p.episode!.id}`)} aria-label={`Open player: ${p.episode.title}`}>
        <Artwork src={p.episode.image_url ?? p.artwork} size={48} radius={10} />
        <div style={{ minWidth: 0 }}>
          <div className="mini__title">{p.episode.title}</div>
          <div className="mini__meta">{status}</div>
        </div>
      </button>
      <AdSkip breaks={p.episode.ad_breaks} positionMs={p.positionMs} onSkip={(ms) => engine.seek(ms)} disabled={p.status !== "ready"} className="ad-skip--mini" />
      <button className="icon-btn" onClick={() => engine.toggle()} aria-label={p.playing ? "Pause" : "Play"} disabled={p.status !== "ready"}>
        <Icon name={p.playing ? "pause" : "play"} size={26} />
      </button>
    </div>
  );
}
