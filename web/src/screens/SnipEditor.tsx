import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, describeError, unwrap } from "../api/client";
import { fetchTranscript } from "../api/transcripts";
import type { EpisodeDetail, Snip, Transcript } from "../api/types";
import { Icon } from "../components/Icon";
import { Sheet } from "../components/Sheet";
import { useToast } from "../components/Toast";
import { mediaPath } from "../lib/media";
import { SpanHistory } from "../lib/spanHistory";
import { setSpanPoint, wordInSpan, type Point } from "../lib/spanPoints";
import { back } from "../lib/router";
import { clock, spanLength } from "../lib/time";
import { chapterAt } from "../lib/transcript";
import { invalidate } from "../lib/useQuery";
import { useEngine } from "../player/PlayerContext";
import { clipPlayer } from "../snips/clipPlayer";

const inSpan = (w: readonly [number, number, ...unknown[]], start: number, end: number) => wordInSpan(w, { start_ms: start, end_ms: end });
/** How much transcript is shown around the snip when the editor opens, and how much "Show earlier/later" adds. */
const WINDOW_STEP_MS = 5 * 60_000;
/** A change of length past this asks whether to rewrite the summary (the server's RESUMMARIZE_OVER_MS). */
const RESUMMARIZE_OVER_MS = 10_000;

/**
 * Boundary editor: choose In or Out at the top, then tap any word in the transcript to put that point there (or
 * nudge by seconds), preview the span from the full recording, and save. Saving creates a new revision on the
 * server (PATCH with if_revision).
 *
 * The transcript window is anchored on the snip as it was when the editor opened and only grows (Show earlier /
 * Show later, or a point moved past its edge), so tapping a word never moves the text under the reader's finger.
 * The view scrolls on its own only when the editor opens and when In or Out is chosen.
 */
export function SnipEditor({ snipId }: { snipId: string }) {
  const engine = useEngine();
  const toast = useToast();
  const [snip, setSnip] = useState<Snip | null>(null);
  const [episode, setEpisode] = useState<EpisodeDetail | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [active, setActive] = useState<Point>("out");
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  /** Save was pressed on a change of length large enough to ask whether the summary should be written again. */
  const [asking, setAsking] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  // The span's own player: a video element for a recording with a picture (shown above the Play button), else audio.
  const preview = useRef<HTMLMediaElement | null>(null);
  const previewBox = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [win, setWin] = useState<{ from: number; to: number } | null>(null);

  // Choosing In and Out points means listening to the span, so the episode pauses when the editor opens
  // (and a clip preview that was playing stops without restarting it). It stays paused when the editor closes.
  useEffect(() => {
    clipPlayer.stop({ resumeMain: false });
    engine.pause();
  }, [engine]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await unwrap(api.GET("/v1/snips/{id}", { params: { path: { id: snipId } }, cache: "no-store" }));
        if (cancelled) return;
        setSnip(s);
        if (s.revision) {
          setStart(s.revision.start_ms);
          setEnd(s.revision.end_ms);
          setTitle(s.revision.title ?? "");
          setWin({ from: Math.max(0, s.revision.start_ms - WINDOW_STEP_MS), to: s.revision.end_ms + WINDOW_STEP_MS });
        }
        const ep = await unwrap(api.GET("/v1/episodes/{id}", { params: { path: { id: s.episode_id } } }));
        if (cancelled) return;
        setEpisode(ep);
        if (ep.transcript_id) {
          const t = await fetchTranscript(ep.transcript_id);
          if (!cancelled) setTranscript(t);
        }
      } catch (e) {
        if (!cancelled) setError(describeError(e));
      }
    })();
    return () => {
      cancelled = true;
      preview.current?.pause();
    };
  }, [snipId]);

  const duration = episode?.asset?.duration_ms ?? Number.MAX_SAFE_INTEGER;
  const segments = useMemo(() => {
    if (!transcript || !win) return [];
    return transcript.segments.filter((s) => s.e >= win.from && s.s <= win.to);
  }, [transcript, win]);
  const allSegments = transcript?.segments ?? [];
  // Global indexes of the span's first and last words, ringed for the point being set. A word is in the snip when
  // its midpoint is, the same rule the server uses to snap a saved span to words, so what is highlighted is what
  // gets saved even where the transcript's word times overlap.
  const edges = useMemo(() => {
    let first = -1, last = -1;
    for (const seg of segments) {
      seg.words.forEach((w, j) => {
        if (inSpan(w, start, end)) {
          if (first < 0) first = seg.w0 + j;
          last = seg.w0 + j;
        }
      });
    }
    return { first, last };
  }, [segments, start, end]);
  const moreEarlier = !!win && allSegments.length > 0 && allSegments[0]!.s < win.from;
  const moreLater = !!win && allSegments.length > 0 && allSegments[allSegments.length - 1]!.e > win.to;

  // A point nudged past the edge of the window widens the window rather than disappearing from view.
  useEffect(() => {
    if (!win) return;
    if (start < win.from || end > win.to) setWin({ from: Math.min(win.from, Math.max(0, start - 60_000)), to: Math.max(win.to, end + 60_000) });
  }, [start, end, win]);

  /** Scroll so the In point's first word, or the Out point's last word, sits a third of the way down the view. */
  const scrollToPoint = (point: Point, behavior: ScrollBehavior = "smooth") => {
    const el = scrollRef.current;
    const words = el?.querySelectorAll<HTMLElement>(".in-span");
    const target = words && words.length > 0 ? (point === "in" ? words[0] : words[words.length - 1]) : null;
    if (!el || !target) return;
    const top = el.scrollTop + (target.getBoundingClientRect().top - el.getBoundingClientRect().top) - el.clientHeight * 0.3;
    el.scrollTo({ top: Math.max(0, top), behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : behavior });
  };

  // Bring the selection into view once, when the transcript first appears.
  const scrolledOnOpen = useRef(false);
  useEffect(() => {
    if (scrolledOnOpen.current || segments.length === 0) return;
    scrolledOnOpen.current = true;
    scrollToPoint("in", "auto");
  }, [segments.length]); // eslint-disable-line react-hooks/exhaustive-deps -- once, on first render of the words

  // Text added above (Show earlier) would push the words down; keep what the reader was looking at in place.
  const heightBeforeEarlier = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || heightBeforeEarlier.current === null) return;
    el.scrollTop += el.scrollHeight - heightBeforeEarlier.current;
    heightBeforeEarlier.current = null;
  }, [win?.from]);
  const showEarlier = () => {
    if (!win) return;
    heightBeforeEarlier.current = scrollRef.current?.scrollHeight ?? null;
    setWin({ ...win, from: Math.max(0, win.from - WINDOW_STEP_MS) });
  };
  const showLater = () => win && setWin({ ...win, to: win.to + WINDOW_STEP_MS });

  /** In and Out before each change, for Cmd+Z and Shift+Cmd+Z. */
  const history = useRef(new SpanHistory());

  /** Put a point at `ms`; the rules (including carrying the other point along) are in lib/spanPoints. */
  const setPoint = (point: Point, ms: number) => {
    const next = setSpanPoint({ start_ms: start, end_ms: end }, point, ms, duration);
    if (next.start_ms === start && next.end_ms === end) return;
    history.current.record({ start_ms: start, end_ms: end });
    setStart(next.start_ms);
    setEnd(next.end_ms);
  };

  // Cmd+Z (Ctrl+Z) takes In and Out back one change, Shift+Cmd+Z puts it again. In the title field the keys keep their
  // usual meaning, undoing typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== "z") return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const current = { start_ms: start, end_ms: end };
      const to = e.shiftKey ? history.current.redo(current) : history.current.undo(current);
      if (!to) return;
      e.preventDefault();
      preview.current?.pause();
      setStart(to.start_ms);
      setEnd(to.end_ms);
      toast(`${e.shiftKey ? "Redone" : "Undone"} · ${clock(to.start_ms)} – ${clock(to.end_ms)}`);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [start, end, toast]);
  const choose = (point: Point) => {
    setActive(point);
    scrollToPoint(point);
  };
  const nudge = (delta: number) => setPoint(active, (active === "in" ? start : end) + delta);

  const togglePreview = () => {
    const asset = episode?.asset;
    const url = asset?.video_url ?? asset?.audio_url;
    if (!url) return;
    if (previewing) {
      preview.current?.pause();
      return;
    }
    if (!preview.current) {
      const a: HTMLMediaElement = asset?.video_url ? document.createElement("video") : new Audio();
      if (a instanceof HTMLVideoElement) {
        a.playsInline = true;
        previewBox.current?.appendChild(a);
      }
      a.addEventListener("pause", () => setPreviewing(false));
      a.addEventListener("ended", () => setPreviewing(false));
      preview.current = a;
    }
    const a = preview.current;
    engine.pause();
    a.src = `${mediaPath(url)}#t=${(start / 1000).toFixed(3)}`;
    const stopAt = end / 1000;
    const onTime = () => {
      if (a.currentTime >= stopAt) {
        a.pause();
        a.removeEventListener("timeupdate", onTime);
      }
    };
    a.addEventListener("timeupdate", onTime);
    setPreviewing(true);
    a.play().catch(() => setPreviewing(false));
  };

  /**
   * Fine-tuning In and Out keeps the title and summary. When the length changes by more than RESUMMARIZE_OVER_MS the
   * owner is asked first whether to write them again (the server's own default for that case is to write them).
   */
  async function save(regenerate?: boolean) {
    if (!snip?.revision) return;
    const changed = start !== snip.revision.start_ms || end !== snip.revision.end_ms;
    const lengthChange = Math.abs(end - start - (snip.revision.end_ms - snip.revision.start_ms));
    if (changed && regenerate === undefined && lengthChange > RESUMMARIZE_OVER_MS && snip.revision.summary_status === "ready") {
      setAsking(true);
      return;
    }
    setAsking(false);
    setSaving(true);
    try {
      const body: { start_ms: number; end_ms: number; if_revision: string; title?: string; regenerate_summary?: boolean } = {
        start_ms: start, end_ms: end, if_revision: snip.revision.id, regenerate_summary: regenerate ?? false,
      };
      const t = title.trim();
      if (t && t !== (snip.revision.title ?? "")) body.title = t;
      await unwrap(api.PATCH("/v1/snips/{id}", { params: { path: { id: snip.id } }, body }));
      invalidate("snips");
      preview.current?.pause();
      toast("Saved · preparing new clip");
      back("/snips");
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409 ? "This snip changed elsewhere. Reopen it to edit the latest version." : describeError(e));
      setSaving(false);
    }
  }

  const rev = snip?.revision;
  const editable = !!rev && rev.status === "ready" && !!transcript;
  const lengthDelta = rev ? end - start - (rev.end_ms - rev.start_ms) : 0;
  const chapter = chapterAt(episode?.chapters?.items, end);
  const activeMs = active === "in" ? start : end;

  return (
    <div className="screen screen--full editor">
      <div className="editor__side">
      <div className="editor__head">
        <button className="btn btn--ghost editor__cancel" onClick={() => { preview.current?.pause(); back("/snips"); }}>Cancel</button>
        <div className="editor__head-mid">
          <h1>Edit snip</h1>
          <span>{chapter?.title ?? snip?.episode_title ?? ""}</span>
        </div>
        <button className="btn btn--ghost editor__save" onClick={() => void save()} disabled={!editable || saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      <div className="editor__points">
        <button className="point" aria-pressed={active === "in"} onClick={() => choose("in")}>
          <small>In</small>
          <strong className="mono">{clock(start)}</strong>
        </button>
        <button className="point" aria-pressed={active === "out"} onClick={() => choose("out")}>
          <small>Out</small>
          <strong className="mono">{clock(end)}</strong>
        </button>
        <div className="point point--readout">
          <small>Length</small>
          <strong className="mono">{spanLength(end - start)}</strong>
        </div>
      </div>

      <section className="editor__adjust" aria-label={`Adjust ${active === "in" ? "in" : "out"} point`}>
        <h2>{active === "in" ? "Tap a word to start the snip there" : "Tap a word to end the snip there"}</h2>
        <div className="nudge">
          <button onClick={() => nudge(-5000)} aria-label={`Move ${active} point back 5 seconds`} disabled={!editable}>−5s</button>
          <button onClick={() => nudge(-1000)} aria-label={`Move ${active} point back 1 second`} disabled={!editable}>−1s</button>
          <div className="readout mono">{clock(activeMs)}</div>
          <button onClick={() => nudge(1000)} aria-label={`Move ${active} point forward 1 second`} disabled={!editable}>+1s</button>
          <button onClick={() => nudge(5000)} aria-label={`Move ${active} point forward 5 seconds`} disabled={!editable}>+5s</button>
        </div>
        <div ref={previewBox} className="editor__preview" hidden={!previewing || !episode?.asset?.video_url} />
        <button className="btn btn--accent btn--block" onClick={togglePreview} disabled={!episode?.asset}>
          <Icon name={previewing ? "stop" : episode?.asset?.video_url ? "video" : "play"} size={17} />
          {previewing ? "Stop" : "Play snip"}
        </button>
        <label className="field">
          <span>Title</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder={rev?.title ?? "Title"} />
        </label>
      </section>
      </div>

      <div className="editor__main">
      <div className="panel">
        <div className="panel__scroll" ref={scrollRef}>
          {error && <p className="error">{error}</p>}
          {!error && !snip && <p className="empty">Loading…</p>}
          {snip && rev && rev.status !== "ready" && <p className="notice">This snip is still being prepared. Boundaries can be edited once the clip is ready.</p>}
          {snip && !episode?.transcript_id && <p className="notice">No transcript for this episode yet, so the words cannot be shown.</p>}
          {moreEarlier && (
            <button className="btn btn--soft editor__more" onClick={showEarlier}>
              <Icon name="arrowUp" size={17} />
              Show earlier
            </button>
          )}
          <div className="transcript transcript--editor">
            {segments.map((seg) => (
              <p key={seg.w0}>
                <time className="tnum">{clock(seg.s)}</time>
                <span className="seg-text">
                  {seg.words.map((w, j) => {
                    const inside = inSpan(w, start, end);
                    const idx = seg.w0 + j;
                    const edge = (active === "in" && idx === edges.first) || (active === "out" && idx === edges.last) ? " w-edge" : "";
                    return (
                      <span
                        key={j}
                        className={`w${inside ? " in-span" : ""}${edge}`}
                        onClick={() => (editable ? setPoint(active, active === "in" ? w[0] : w[1]) : undefined)}
                      >
                        {w[2]}{" "}
                      </span>
                    );
                  })}
                </span>
              </p>
            ))}
          </div>
          {moreLater && (
            <button className="btn btn--soft editor__more" onClick={showLater}>
              <Icon name="arrowDown" size={17} />
              Show later
            </button>
          )}
        </div>
        {segments.length > 0 && (
          <button className="follow" onClick={() => scrollToPoint(active)}>
            <Icon name="target" size={19} strokeWidth={2.2} />
            {active === "in" ? `Go to In · ${clock(start)}` : `Go to Out · ${clock(end)}`}
          </button>
        )}
      </div>
      </div>
      {asking && (
        <Sheet onClose={() => setAsking(false)} label="Rewrite the summary?">
          <h2 className="sheet__title">Rewrite the summary?</h2>
          <p style={{ color: "var(--text-2)", margin: "4px 0 16px" }}>
            The clip is now {spanLength(Math.abs(lengthDelta))} {lengthDelta > 0 ? "longer" : "shorter"}.{" "}
            {rev?.title_source === "owner" ? "Your title stays either way." : "Rewriting also writes a new title."}
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <button className="btn btn--accent" onClick={() => void save(true)}>Rewrite summary</button>
            <button className="btn" onClick={() => void save(false)}>Keep current summary</button>
          </div>
        </Sheet>
      )}
    </div>
  );
}
