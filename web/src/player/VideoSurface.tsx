import { useEffect, useRef, type CSSProperties } from "react";
import { Icon } from "../components/Icon";
import { useEngine } from "./PlayerContext";

/**
 * The engine's video element, put where the player's artwork goes while a recording with a picture plays as video.
 * The element belongs to the engine (one for the whole app, so playback never restarts when the screen changes);
 * this only places it, and hands it back to the engine when the screen leaves.
 *
 * `size` is how much room it gets: "full" is the upright player's, a box that gives up height to the transcript down to
 * a floor and scales the picture rather than cropping it; "hero" fills the height the short landscape layout leaves;
 * "small" is a thumbnail beside the title, for when the player is compact. Those two go full screen on a tap.
 */
export function VideoSurface({ size = "full", aspect }: { size?: "full" | "hero" | "small"; aspect: number }) {
  const engine = useEngine();
  const surface = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = surface.current;
    if (box) engine.placeVideo(box);
    return () => {
      if (box && engine.videoEl.parentElement === box) engine.placeVideo(null);
    };
  }, [engine]);
  const style = { "--video-aspect": aspect } as CSSProperties;
  const picture = (
    <div ref={surface} className={`video-surface video-surface--${size}`} style={size === "full" ? undefined : style} onClick={size === "full" ? undefined : () => engine.enterVideoFullscreen()} onDoubleClick={size === "full" ? () => engine.enterVideoFullscreen() : undefined}>
      {size !== "small" && (
        <button className="video-surface__full" onClick={(e) => { e.stopPropagation(); engine.enterVideoFullscreen(); }} aria-label="Full screen">
          <Icon name="expand" size={18} strokeWidth={2.2} />
        </button>
      )}
    </div>
  );
  return size === "full" ? <div className="video-box" style={style}>{picture}</div> : picture;
}
