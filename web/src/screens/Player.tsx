import { useCallback, useEffect, useRef, useState } from "react";
import { fetchTranscript } from "../api/transcripts";
import type { Snip, Transcript } from "../api/types";
import { Artwork } from "../components/Artwork";
import { Icon } from "../components/Icon";
import { useToast } from "../components/Toast";
import { Sheet } from "../components/Sheet";
import { back, navigate } from "../lib/router";
import { clock, relativeDay } from "../lib/time";
import { useDesktop, useShortLandscape, useWide } from "../lib/layout";
import { chapterAt } from "../lib/transcript";
import { useQuery } from "../lib/useQuery";
import { AdSkip } from "../player/AdSkip";
import { Chapters } from "../player/Chapters";
import { useEngine, usePlayer } from "../player/PlayerContext";
import { Scrubber } from "../player/Scrubber";
import { TranscriptView } from "../player/TranscriptView";
import { VideoSurface } from "../player/VideoSurface";
import { describeError } from "../api/client";
import { requestVideo } from "../api/video";
import { VideoDetails } from "./VideoDetails";
import { UpNext } from "../player/UpNext";
import { snipOutbox } from "../snips/outbox";
import { clipPlayer } from "../snips/clipPlayer";
import { EpisodeSnips } from "../snips/EpisodeSnips";
import { SnipSheet, recallSheet, rememberSheet, type SheetState } from "../snips/SnipSheet";
import { useFeeds } from "./Today";

type Tab = "chapters" | "transcript" | "upnext";

export function Player({ episodeId }: { episodeId: string }) {
  const engine = useEngine();
  const p = usePlayer();
  const toast = useToast();
  const wide = useWide();
  const short = useShortLandscape();
  const desktop = useDesktop();
  const episode = p.episode?.id === episodeId ? p.episode : null;
  const [compact, setCompact] = useState(false);
  const [tab, setTab] = useState<Tab>("transcript");
  const [menu, setMenu] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const [snipList, setSnipList] = useState(false);
  const feeds = useFeeds();
  const artwork = episode?.image_url ?? feeds.data?.find((f) => f.id === episode?.feed_id)?.image_url ?? null;
  const [sheet, setSheetState] = useState<SheetState | null>(() => recallSheet(episodeId));
  const setSheet = (next: SheetState | null) => {
    rememberSheet(episodeId, next);
    setSheetState(next);
  };
  const [snipping, setSnipping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // While the snip card is up, use the compact layout so Play and Snip sit above it; restore on dismiss. In the wide
  // layout the card docks over the reading column and the controls never move, so nothing needs clearing.
  const compactForSheet = useRef(false);
  const sheetOpen = sheet !== null;
  useEffect(() => {
    if (sheetOpen && !compact && !wide) {
      compactForSheet.current = true;
      setCompact(true);
    } else if ((!sheetOpen || wide) && compactForSheet.current) {
      compactForSheet.current = false;
      setCompact(false);
    }
  }, [sheetOpen, wide]); // eslint-disable-line react-hooks/exhaustive-deps -- reacts to the card and the layout, not to manual toggles

  useEffect(() => {
    if (engine.getState().episodeId !== episodeId) void engine.open(episodeId);
  }, [episodeId, engine]);
  useEffect(() => {
    engine.setArtwork(artwork);
  }, [artwork, engine]);

  // With a keyboard: Space plays or pauses, ← and → skip back 15 and forward 30 seconds. Keys aimed at a control, a
  // field or an open dialog keep their usual meaning.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || engine.getState().status !== "ready") return;
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || target.closest("input, textarea, select, button, a, [role=dialog]"))) return;
      if (e.key === " ") engine.toggle();
      else if (e.key === "ArrowLeft") engine.skip(-15_000);
      else if (e.key === "ArrowRight") engine.skip(30_000);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [engine]);

  // A tap made offline turns into a real snip whenever the outbox gets through.
  useEffect(
    () =>
      snipOutbox.subscribe((e) => {
        if (e.type === "sent" && sheet?.kind === "waiting" && sheet.pending.client_request_id === e.pending.client_request_id) setSheet({ kind: "snip", id: e.snip.id, initial: e.snip });
        if (e.type === "failed" && sheet?.kind === "waiting" && sheet.pending.client_request_id === e.pending.client_request_id) setSheet(null);
      }),
    [sheet],
  );

  const transcriptId = episode?.transcript_id ?? null;
  const transcript = useQuery<Transcript>(transcriptId ? `transcript:${transcriptId}` : null, () => fetchTranscript(transcriptId!));
  const chapters = episode?.chapters?.items;
  const chapterNow = chapterAt(chapters, p.positionMs);

  const snip = async () => {
    const payload = engine.snipPayload();
    if (!payload || !episode) return;
    setSnipping(true);
    try {
      const result = await snipOutbox.capture({ ...payload, episode_id: episode.id });
      const pending = snipOutbox.pending().find((x) => x.asset_id === payload.asset_id && x.anchor_ms === payload.anchor_ms);
      if (result) setSheet({ kind: "snip", id: result.id, initial: result });
      else if (pending) setSheet({ kind: "waiting", pending });
    } finally {
      setSnipping(false);
    }
  };
  // The snip on the card, drawn above the seek bar at its true share of the episode while the card is up.
  const [snipSpan, setSnipSpan] = useState<{ start_ms: number; end_ms: number } | null>(null);
  useEffect(() => {
    if (!sheetOpen) setSnipSpan(null);
  }, [sheetOpen]);
  const onSnipChange = useCallback((s: Snip) => {
    const r = s.revision;
    setSnipSpan(r && s.episode_id === episodeId ? { start_ms: r.start_ms, end_ms: r.end_ms } : null);
    // A ready snip means the server also counted it; refresh snip_count and resume without touching playback.
    if (r?.status === "ready" && episode && episode.snip_count === 0) void engine.refreshEpisode();
  }, [engine, episode, episodeId]);
  const seek = (ms: number) => engine.seek(ms);

  const title = episode?.title ?? "Loading…";
  const video = episode?.video;
  const videoWidth = episode?.asset?.video_width;
  const videoHeight = episode?.asset?.video_height;
  const videoAspect = videoWidth && videoHeight ? videoWidth / videoHeight : 16 / 9;
  const videoLine = video?.status === "requested" ? (episode?.media_kind === "video" && !episode.asset ? "Fetching the video…" : "The video is on its way…") : video?.status === "failed" ? `The video could not be fetched: ${video.error ?? "unknown error"}` : "";
  // A video on its way is the news, even while the recording is still being prepared.
  const statusLine = video?.status === "requested" ? videoLine : p.status === "preparing" ? "Preparing the recording…" : p.status === "loading" ? "Loading…" : p.status === "error" ? p.error : p.error ? p.error : p.buffering ? "Buffering…" : videoLine;

  // A video on its way: read the episode now and then, and once the video is the recording, play on from it.
  useEffect(() => {
    if (video?.status !== "requested" || !episode) return;
    const timer = window.setInterval(async () => {
      await engine.refreshEpisode().catch(() => undefined);
      const ep = engine.getState().episode;
      if (ep?.video.status === "ready" && ep.asset?.id !== p.assetId) void engine.reload();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [video?.status, episode, engine, p.assetId]);

  async function watchVideo() {
    if (!episode) return;
    setMenu(false);
    try {
      await requestVideo(episode.id);
      await engine.refreshEpisode();
    } catch (e) {
      toast(describeError(e));
    }
  }

  if (p.status === "details" && episode) return <VideoDetails episode={episode} artwork={artwork} onFetch={watchVideo} />;

  return (
    <div className={`screen screen--full player${p.video ? " player--video" : ""}${sheetOpen ? (wide ? " player--docked" : " player--card") : ""}`}>
      <div className="player__side">
      <div className="player__top">
        <button className="icon-btn" onClick={() => back("/")} aria-label={desktop ? "Back" : "Close player"}>
          <Icon name={desktop ? "chevronLeft" : "chevronDown"} size={27} strokeWidth={2.1} />
        </button>
        <div className="player__top-mid">
          <small>Now playing</small>
          <strong>{episode ? <ShowLink feedId={episode.feed_id} title={episode.show_title} /> : ""}</strong>
        </div>
        <button ref={menuButton} className="icon-btn" onClick={() => setMenu(true)} aria-label="More options" aria-haspopup="dialog">
          <Icon name="more" size={25} />
        </button>
      </div>

      {/* `compact` hides the artwork to give the panel room. Shown, it sits above the title where there is height for it;
          in short landscape it sits beside the title and grows to fill whatever height the controls leave. */}
      {compact || short ? (
        <div className={`player__titles player__titles--compact${short && !compact ? " player__titles--hero" : ""}`}>
          {p.video ? (
            <VideoSurface size={compact ? "small" : "hero"} aspect={videoAspect} />
          ) : (
            !compact && <Artwork src={artwork} size={short ? "var(--hero-art)" : 64} radius={12} className="player__art player__art--small" />
          )}
          <div style={{ minWidth: 0 }}>
            <h1>{title}</h1>
            <div className="player__show" style={{ fontSize: 15 }}>
              {episode && <ShowLink feedId={episode.feed_id} title={episode.show_title} />}
              {episode?.published_at ? ` · ${relativeDay(episode.published_at)}` : ""}
            </div>
          </div>
        </div>
      ) : (
        <>
          {p.video ? (
            <VideoSurface aspect={videoAspect} />
          ) : wide ? (
            <Artwork src={artwork} size="var(--art-size)" radius={20} className="player__art" alt="" />
          ) : (
            // Upright, the artwork gives way first: its box shrinks so the transcript keeps a usable height, and the
            // cover goes once there is no longer room for a meaningful one.
            <div className="player__art-box">
              <Artwork src={artwork} size="var(--portrait-art)" radius={20} className="player__art" alt="" />
            </div>
          )}
          <div className="player__titles">
            <h1>{title}</h1>
            <div className="player__show">
              {episode && <ShowLink feedId={episode.feed_id} title={episode.show_title} />}
              {episode?.published_at ? ` · ${relativeDay(episode.published_at)}` : ""}
            </div>
          </div>
        </>
      )}

      <div className="player__scrub">
        <AdSkip breaks={episode?.ad_breaks} positionMs={p.positionMs} onSkip={seek} disabled={p.status !== "ready"} />
        <Scrubber positionMs={p.positionMs} durationMs={p.durationMs || episode?.duration_ms || 0} chapters={chapters} span={sheetOpen ? snipSpan : null} onSeek={seek} />
        <div className="player__times tnum">
          <span>{clock(p.positionMs)}</span>
          <span className="chapter-now">{chapterNow?.title ?? ""}</span>
          <span>−{clock(Math.max(0, (p.durationMs || episode?.duration_ms || 0) - p.positionMs))}</span>
        </div>
      </div>

      <div className="player__controls">
        <button className="ctl-pill tnum" onClick={() => engine.cycleSpeed()} aria-label={`Playback speed, ${p.speed} times`}>
          {p.speed}×
        </button>
        <button className="ctl-skip" onClick={() => engine.skip(-15_000)} aria-label="Back 15 seconds" disabled={p.status !== "ready"}>
          <Icon name="back15" size={38} strokeWidth={1.7} />
          <span aria-hidden="true">15</span>
        </button>
        <button className="ctl-play" onClick={() => engine.toggle()} aria-label={p.playing ? "Pause" : "Play"} disabled={p.status !== "ready"}>
          <Icon name={p.playing ? "pause" : "play"} size={30} />
        </button>
        <button className="ctl-skip" onClick={() => engine.skip(30_000)} aria-label="Forward 30 seconds" disabled={p.status !== "ready"}>
          <Icon name="fwd30" size={38} strokeWidth={1.7} />
          <span aria-hidden="true">30</span>
        </button>
        <button className="ctl-pill" onClick={() => { setTab("chapters"); setCompact(true); }} aria-label="Chapters" aria-pressed={compact && tab === "chapters"}>
          <Icon name="list" size={23} />
        </button>
      </div>

      <div className="player__actions">
        <button className="btn btn--accent" onClick={() => void snip()} disabled={p.status !== "ready" || snipping} aria-label="Snip the last moments">
          <Icon name="snip" size={24} strokeWidth={2.2} />
          Snip
        </button>
        <button
          className="ctl-round ctl-round--count"
          onClick={() => { setSheet(null); setSnipList(true); }}
          disabled={!episode}
          aria-label={`Snips from this episode${episode ? `, ${episode.snip_count}` : ""}`}
          aria-haspopup="dialog"
        >
          <Icon name="stack" size={24} />
          {episode && episode.snip_count > 0 && <span className="count-badge tnum" aria-hidden="true">{episode.snip_count > 99 ? "99+" : episode.snip_count}</span>}
        </button>
      </div>

      {statusLine && <div className="player__status" role="status">{statusLine}</div>}
      </div>

      <div className="player__main">
      {episode && (
        <>
          <div className="seg" role="tablist" aria-label="Transcript, chapters or up next">
            <button role="tab" aria-pressed={tab === "transcript"} aria-selected={tab === "transcript"} onClick={() => setTab("transcript")}>Transcript</button>
            <button role="tab" aria-pressed={tab === "chapters"} aria-selected={tab === "chapters"} onClick={() => setTab("chapters")}>Chapters</button>
            <button role="tab" aria-pressed={tab === "upnext"} aria-selected={tab === "upnext"} onClick={() => setTab("upnext")}>Up next</button>
          </div>
          <div className="panel">
            <div className={`panel__scroll${sheet ? " panel__scroll--sheet" : ""}`} ref={scrollRef}>
              {tab === "upnext" ? (
                <UpNext currentId={episode.id} />
              ) : tab === "chapters" ? (
                <Chapters chapters={chapters ?? []} positionMs={p.positionMs} onSeek={seek} />
              ) : (
                <TranscriptView
                  transcript={transcript.data ?? null}
                  positionMs={p.positionMs}
                  onSeek={seek}
                  scrollRef={scrollRef}
                  status={!transcriptId ? "none" : transcript.error ? "error" : transcript.data ? "ready" : "loading"}
                  coverKey={`${sheetOpen}-${compact}-${wide}`}
                />
              )}
            </div>
          </div>
        </>
      )}

      {/* Inside the reading column so that on a desktop the card can sit at its foot; elsewhere it is fixed to the screen. */}
      {sheet && <SnipSheet state={sheet} chapters={chapters} onClose={() => { clipPlayer.stop(); setSheet(null); }} onSnipChange={onSnipChange} />}

      {snipList && episode && (
        <EpisodeSnips
          episodeId={episode.id}
          episodeTitle={episode.title}
          onClose={() => setSnipList(false)}
          onOpen={(s) => { setSnipList(false); setSheet({ kind: "snip", id: s.id, initial: s }); }}
        />
      )}
      </div>

      {menu && episode && (
        <Sheet onClose={() => setMenu(false)} label="Episode options" anchor={menuButton.current}>
          <div className="menu">
            <button onClick={() => { engine.markFinished(); setMenu(false); }} disabled={p.status !== "ready"}>
              <span>Mark as played</span>
              <Icon name="check" size={22} />
            </button>
            {(episode.video.status === "available" || episode.video.status === "failed") && (
              <button onClick={() => void watchVideo()}>
                <span>{episode.video.status === "failed" ? "Try the video again" : "Watch video"}</span>
                <Icon name="video" size={22} />
              </button>
            )}
            {episode.asset?.video_url && (
              <button onClick={() => { engine.setWantsVideo(!p.video); setMenu(false); }}>
                <span>{p.video ? "Sound only" : "Play video"}</span>
                <Icon name={p.video ? "eyeOff" : "video"} size={22} />
              </button>
            )}
            <button onClick={() => { setMenu(false); navigate(`/library/${episode.feed_id}`); }}>
              <span>Go to show</span>
              <Icon name="chevronRight" size={22} />
            </button>
            <button onClick={() => { setMenu(false); compactForSheet.current = false; setCompact((v) => !v); }}>
              <span>{p.video ? (compact ? "Larger video" : "Smaller video") : compact ? "Show artwork" : "Hide artwork"}</span>
              <Icon name={compact ? "eye" : "eyeOff"} size={22} />
            </button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

/** The show's name, which opens the show's page; the episode keeps playing in the mini player. */
function ShowLink({ feedId, title }: { feedId: string; title: string | null }) {
  if (!title) return null;
  return (
    <button type="button" className="show-link" onClick={() => navigate(`/library/${feedId}`)}>
      {title}
    </button>
  );
}
