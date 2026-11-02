import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { Chapter } from "../api/types";
import { clock } from "../lib/time";

/** Gap between chapter segments, in pixels. Segments are inset by half of it on each side so every marker shares one linear scale. */
const SEG_GAP_PX = 3;

const pctOf = (ms: number, dur: number) => Math.min(100, Math.max(0, (ms / dur) * 100));

/**
 * Seek bar split by chapter when the episode has chapters; drag anywhere, arrows nudge 5 s.
 * The bar above the track marks `span` (the snip on screen) when given, otherwise the current chapter. Everything,
 * thumb, segments, and markers, is positioned on the same scale: a millisecond maps to the same x everywhere.
 */
export function Scrubber({ positionMs, durationMs, chapters, span, onSeek }: { positionMs: number; durationMs: number; chapters: Chapter[] | undefined; span?: { start_ms: number; end_ms: number } | null; onSeek: (ms: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? positionMs;
  const dur = Math.max(durationMs, 1);
  const pct = pctOf(shown, dur);

  const msFromEvent = (e: PointerEvent) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r || r.width === 0) return 0;
    return Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * dur);
  };
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag(msFromEvent(e));
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag !== null) setDrag(msFromEvent(e));
  };
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    if (drag === null) return;
    const to = msFromEvent(e);
    setDrag(null);
    onSeek(to);
  };
  const onKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 30_000 : 5_000;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") onSeek(Math.min(dur, positionMs + step));
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") onSeek(Math.max(0, positionMs - step));
    else if (e.key === "Home") onSeek(0);
    else if (e.key === "End") onSeek(dur);
    else return;
    e.preventDefault();
  };

  const segs = chapters && chapters.length > 1 ? chapters : [{ start_ms: 0, end_ms: dur } as Chapter];
  const activeIdx = Math.max(0, segs.findIndex((c, i) => shown >= c.start_ms && (i === segs.length - 1 || shown < (segs[i + 1]?.start_ms ?? dur))));

  return (
    <div
      ref={ref}
      className="scrub"
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(dur / 1000)}
      aria-valuenow={Math.round(shown / 1000)}
      aria-valuetext={`${clock(shown)} of ${clock(dur)}`}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={() => setDrag(null)}
      onKeyDown={onKey}
    >
      {span && span.end_ms > span.start_ms ? (
        <div
          className="scrub__active scrub__active--snip"
          data-testid="snip-span"
          aria-hidden="true"
          style={{ left: `${pctOf(span.start_ms, dur)}%`, width: `${pctOf(span.end_ms, dur) - pctOf(span.start_ms, dur)}%` }}
        />
      ) : (
        segs.length > 1 && (
          <div
            className="scrub__active"
            aria-hidden="true"
            style={{ left: `${pctOf(segs[activeIdx]?.start_ms ?? 0, dur)}%`, width: `${pctOf(segs[activeIdx + 1]?.start_ms ?? dur, dur) - pctOf(segs[activeIdx]?.start_ms ?? 0, dur)}%` }}
          />
        )
      )}
      <div className="scrub__track" aria-hidden="true">
        {segs.map((c, i) => {
          const start = c.start_ms;
          const end = segs[i + 1]?.start_ms ?? dur;
          const left = pctOf(start, dur);
          const width = pctOf(end, dur) - left;
          const fill = shown <= start ? 0 : shown >= end ? 100 : ((shown - start) / (end - start)) * 100;
          const inset = segs.length > 1 ? SEG_GAP_PX / 2 : 0;
          return (
            <div key={i} className="scrub__seg" style={{ left: `calc(${left}% + ${inset}px)`, width: `max(0px, calc(${width}% - ${2 * inset}px))` }}>
              <i style={{ width: `${fill}%` }} />
            </div>
          );
        })}
      </div>
      <div className="scrub__thumb" aria-hidden="true" style={{ left: `${pct}%` }} />
    </div>
  );
}
