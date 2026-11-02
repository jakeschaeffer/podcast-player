import { memo, useCallback, useEffect, useRef, useState } from "react";
import { fetchSpeakers, speakerName, type Speaker } from "../api/transcripts";
import type { Segment, Transcript } from "../api/types";
import { Icon } from "../components/Icon";
import { clock } from "../lib/time";
import { segmentIndexAt, wordIndexAt } from "../lib/transcript";

/** Where the spoken line is kept: this far down the part of the transcript the reader can actually see. */
const ANCHOR = 0.3;

/**
 * The part of the scroll area that is on screen and not under the snip card. The card is fixed to the bottom of the
 * screen and overlaps the transcript, so following by the scroll area's own height would park the spoken line under it.
 */
function visibleBand(el: HTMLElement): { top: number; bottom: number } {
  const r = el.getBoundingClientRect();
  const top = Math.max(r.top, 0);
  let bottom = Math.min(r.bottom, window.innerHeight);
  const card = document.querySelector<HTMLElement>(".sheet--snip");
  if (card) {
    const c = card.getBoundingClientRect();
    if (c.left < r.right && c.right > r.left && c.top < bottom) bottom = Math.max(top, c.top);
  }
  return { top, bottom };
}

/**
 * The transcript follows playback word by word: the word being spoken (found by binary search) is highlighted and
 * its line kept a third of the way down the visible part of the transcript, scrolling a line at a time as speech moves
 * on. It re-aims when the snip card opens or closes (`coverKey`) and when the screen turns, and jumps without
 * animation after a seek. Scrolling away stops following until "Follow audio" is tapped.
 */
export function TranscriptView({ transcript, positionMs, onSeek, scrollRef, status, coverKey }: { transcript: Transcript | null; positionMs: number; onSeek: (ms: number) => void; scrollRef: React.RefObject<HTMLDivElement | null>; status: "loading" | "ready" | "none" | "error"; coverKey?: string | number | boolean }) {
  const [following, setFollowing] = useState(true);
  const segments = transcript?.segments ?? [];
  // Names for the speaker labels, when the server knows them; "Speaker 1" until then.
  const [speakers, setSpeakers] = useState<{ id: string; list: Speaker[] | null } | null>(null);
  useEffect(() => {
    const id = transcript?.id;
    if (!id) return;
    let live = true;
    fetchSpeakers(id).then((list) => live && setSpeakers({ id, list }), () => undefined);
    return () => {
      live = false;
    };
  }, [transcript?.id]);
  const known = speakers && speakers.id === transcript?.id ? speakers.list : null;
  const current = segmentIndexAt(segments, positionMs);
  const wordNow = current >= 0 ? wordIndexAt(segments[current]!, positionMs) : -1;

  // Only the reader's own gestures stop following; the programmatic scroll below never does.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const stop = () => setFollowing(false);
    const onKey = (e: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(e.key)) stop();
    };
    el.addEventListener("wheel", stop, { passive: true });
    el.addEventListener("touchmove", stop, { passive: true });
    el.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("wheel", stop);
      el.removeEventListener("touchmove", stop);
      el.removeEventListener("keydown", onKey);
    };
  }, [scrollRef]);

  /**
   * Bring the spoken word's line to the anchor. Unforced, it moves only once the word has gone a line past the anchor
   * (or back above it), so the text steps up one line at a time instead of drifting down the screen.
   */
  const follow = useCallback((force: false | "smooth" | "instant") => {
    const el = scrollRef.current;
    if (!el || current < 0) return;
    const seg = el.querySelector<HTMLElement>(`[data-seg="${current}"]`);
    const target = seg?.querySelector<HTMLElement>(".w-now") ?? seg;
    if (!seg || !target) return;
    const band = visibleBand(el);
    const height = band.bottom - band.top;
    if (height < 20) return; // nothing visible to follow into
    const line = parseFloat(getComputedStyle(seg).lineHeight) || 31;
    const anchor = band.top + Math.min(height * ANCHOR, Math.max(0, height - line * 2));
    const off = target.getBoundingClientRect().top - anchor;
    if (!force && Math.abs(off) < line * 0.75) return;
    const instant = force === "instant" || Math.abs(off) > height * 2 || matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ top: Math.max(0, el.scrollTop + off), behavior: instant ? "auto" : "smooth" });
  }, [current, scrollRef]);

  // Every word: keep up with speech.
  useEffect(() => {
    if (following) follow(false);
  }, [following, current, wordNow, follow]);

  // Opening the transcript, or tapping Follow audio: go straight to the spoken word.
  const shown = useRef(false);
  useEffect(() => {
    if (!following || segments.length === 0) return;
    follow(shown.current ? "smooth" : "instant");
    shown.current = true;
  }, [following, segments.length]); // eslint-disable-line react-hooks/exhaustive-deps -- on showing and on resuming only

  // The visible part changes when the snip card comes or goes (after its slide and the layout change) or the
  // screen turns: re-aim at the new third.
  useEffect(() => {
    if (!following) return;
    const t = window.setTimeout(() => follow("smooth"), 260);
    return () => window.clearTimeout(t);
  }, [coverKey]); // eslint-disable-line react-hooks/exhaustive-deps -- only when what covers the transcript changes
  useEffect(() => {
    let t = 0;
    const onResize = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => followRef.current?.("instant"), 150);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.clearTimeout(t);
    };
  }, []);
  const followRef = useRef<typeof follow | null>(null);
  followRef.current = following ? follow : null;

  if (status === "none") return <p className="empty">No transcript yet. It appears here once the episode is processed.</p>;
  if (status === "error") return <p className="empty">The transcript could not be loaded.</p>;
  if (status === "loading" || !transcript) return <p className="empty">Loading transcript…</p>;

  return (
    <>
      {!following && (
        <button
          className="follow"
          onClick={() => {
            setFollowing(true);
          }}
        >
          <Icon name="arrowUp" size={19} strokeWidth={2.2} />
          Follow audio
        </button>
      )}
      <div className="transcript">
        {segments.map((seg, i) => (
          <SegmentP key={i} index={i} seg={seg} isCurrent={i === current} positionMs={i === current ? positionMs : 0} speaker={seg.spk && seg.spk !== (segments[i - 1]?.spk ?? null) ? speakerName(seg.spk, known) : null} onSeek={onSeek} />
        ))}
      </div>
    </>
  );
}

const SegmentP = memo(function SegmentP({ index, seg, isCurrent, positionMs, speaker, onSeek }: { index: number; seg: Segment; isCurrent: boolean; positionMs: number; speaker: string | null; onSeek: (ms: number) => void }) {
  const wordNow = isCurrent ? wordIndexAt(seg, positionMs) : -1;
  return (
    <p data-seg={index} className={isCurrent ? "is-current" : undefined} onClick={() => onSeek(seg.s)}>
      <time className="tnum">
        {clock(seg.s)}
        {speaker && <span className="spk">{speaker}</span>}
      </time>
      {isCurrent ? (
        <span className="seg-text">
          {seg.words.map((w, j) => (
            <span key={j} className={j === wordNow ? "w-now" : undefined}>
              {w[2]}{" "}
            </span>
          ))}
        </span>
      ) : (
        <span className="seg-text">{seg.words.map((w) => w[2]).join(" ")}</span>
      )}
    </p>
  );
});
