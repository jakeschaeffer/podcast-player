import { api, describeError, unwrap } from "../api/client";
import type { EpisodeDetail } from "../api/types";
import { mediaPath } from "../lib/media";
import { readJson, writeJson } from "../lib/storage";
import { HeardTracker } from "./heard";
import { reportPlayback } from "./reporter";

/**
 * The player engine from docs/core/01-playback.md, wrapped around one <audio> element.
 *
 *   load(asset) → position = resume or 0; the 3 minutes before a resume point count as heard
 *   play/pause  → heard audio unchanged
 *   seek(to)    → position = to; heard_from = start of the heard stretch containing `to` (see heard.ts)
 *   ended       → finished = true
 *   snip()      → { asset_id, anchor_ms: position, heard_from_ms }
 *
 * heard_from only moves forward past audio that was really skipped: skipping back inside audio already played,
 * or reloading and resuming, keeps what was heard, so a snip right after either still gets a full-length clip.
 *
 * Staying put on iPhone: iOS may discard a paused, backgrounded page and reload it later. The engine remembers the
 * episode and position on this device (restoreLast) so the mini player and Play are ready after a reload, renews an
 * expired or failed audio URL every time it is needed (not just once), and resyncs when the page comes back.
 *
 * Reports go out every 15 s while playing and at once on pause, seek, hide, and unload.
 */
export type PlayerStatus = "idle" | "loading" | "details" | "preparing" | "ready" | "error";

export interface PlayerState {
  /** The recording is playing through the video element (it has a picture, and video is wanted). */
  video: boolean;
  status: PlayerStatus;
  /** The episode last asked for, set synchronously by open(); `episode` fills in once fetched. */
  episodeId: string | null;
  episode: EpisodeDetail | null;
  /** Show artwork to use when the episode has none; set by the screen that knows the feed. */
  artwork: string | null;
  assetId: string | null;
  positionMs: number;
  durationMs: number;
  speed: number;
  playing: boolean;
  buffering: boolean;
  heardFromMs: number;
  finished: boolean;
  error: string | null;
}

const VIDEO_KEY = "pp.video";
const SPEED_KEY = "pp.speed";
const REPORT_EVERY_MS = 15_000;
const PREPARE_POLL_MS = 2_000;
export const SPEEDS = [1, 1.25, 1.5, 1.75, 2];
/** The longest automatic snip (the server's max_ms); audio this far before a resume point counts as heard. */
const RESUME_ASSUMED_HEARD_MS = 180_000;
/** Where this device last was, so a reload (iOS discards background pages) comes back to the same spot. */
const LAST_KEY = "pp.player.last";
const LAST_MAX_AGE_MS = 14 * 24 * 3600 * 1000;
/** Renew the signed audio URL when it has less than this left. */
const URL_RENEW_MARGIN_S = 10 * 60;
type LastPlayed = { episodeId: string; assetId?: string; positionMs: number; at: number; finished?: boolean };
// A 44-byte silent WAV: playing it inside a tap unlocks the element so a later programmatic play() is allowed on iOS.
const SILENT = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";

export class PlayerEngine {
  private readonly audioEl: HTMLAudioElement = new Audio();
  /** The picture, when the recording has one: the player puts this element where the artwork goes. It plays the sound too. */
  readonly videoEl: HTMLVideoElement = document.createElement("video");
  /**
   * Where the video element waits while no screen shows it. A media element taken out of the document pauses, so it
   * stays in the document, unseen, and the sound goes on while the picture is not on screen.
   */
  private readonly videoHome: HTMLDivElement = document.createElement("div");
  /** Whichever element the recording is playing through; the other is idle. */
  private get media(): HTMLMediaElement {
    return this.state.video ? this.videoEl : this.audioEl;
  }
  private state: PlayerState;
  private listeners = new Set<() => void>();
  private reportTimer: number | null = null;
  /** A seek, or the resume point, the media element has not yet reported back: held and reasserted until it does. */
  private pendingSeek: { ms: number; tries: number } | null = null;
  private openToken = 0;
  private loading = false;
  private unlocked = false;
  private renewedUrl = false;
  private heard = new HeardTracker();
  /** The recording played to its end (after the finished report); the app starts the next one up next. */
  onEnded: ((episodeId: string) => void) | null = null;

  constructor() {
    this.state = {
      status: "idle", episodeId: null, episode: null, artwork: null, assetId: null, positionMs: 0, durationMs: 0, speed: readJson<number>(SPEED_KEY, 1),
      playing: false, buffering: false, heardFromMs: 0, finished: false, error: null, video: false,
    };
    this.videoEl.playsInline = true;
    this.videoEl.setAttribute("webkit-playsinline", "");
    this.videoHome.setAttribute("aria-hidden", "true");
    this.videoHome.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;overflow:hidden;pointer-events:none;";
    this.videoHome.append(this.videoEl);
    document.body.append(this.videoHome);
    for (const a of [this.audioEl, this.videoEl]) this.bind(a);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.report({ keepalive: true });
      else this.onVisible();
    });
    window.addEventListener("pagehide", () => this.report({ keepalive: true }));
    this.installMediaSession();
  }

  /** The element's events drive the state, but only while the recording plays through that element. */
  private bind(a: HTMLMediaElement) {
    a.preload = "metadata";
    a.addEventListener("timeupdate", () => {
      if (this.loading || a !== this.media) return;
      const pos = Math.round(a.currentTime * 1000);
      // WebKit can apply the URL's start-time fragment after metadata arrives, undoing a seek made just before it;
      // until the element reports a position near the seek, reassert it instead of letting the position drift.
      const want = this.pendingSeek;
      if (want) {
        if (Math.abs(pos - want.ms) > 1500 && want.tries < 3) {
          want.tries++;
          a.currentTime = want.ms / 1000;
          return;
        }
        this.pendingSeek = null;
      }
      this.heard.tick(pos, !a.paused, a.playbackRate || 1, performance.now());
      this.set({ positionMs: pos });
      this.syncPositionState();
    });
    a.addEventListener("durationchange", () => {
      if (!this.loading && a === this.media && Number.isFinite(a.duration) && a.duration > 0) this.set({ durationMs: Math.round(a.duration * 1000) });
    });
    a.addEventListener("play", () => {
      if (this.loading || a !== this.media) return;
      this.set({ playing: true, finished: false, error: null });
      this.startReporting();
      this.report();
    });
    a.addEventListener("pause", () => {
      if (this.loading || a !== this.media) return;
      this.set({ playing: false, buffering: false });
      this.stopReporting();
      if (!a.ended) this.report();
    });
    a.addEventListener("ended", () => {
      if (this.loading || a !== this.media) return;
      this.set({ playing: false, finished: true, positionMs: this.state.durationMs });
      this.stopReporting();
      this.report();
      if (this.state.episodeId) this.onEnded?.(this.state.episodeId);
    });
    a.addEventListener("waiting", () => { if (a === this.media) this.set({ buffering: true }); });
    a.addEventListener("playing", () => {
      if (a !== this.media) return;
      this.set({ buffering: false, error: null });
      this.renewedUrl = false; // playback works again; a later failure may renew again
    });
    a.addEventListener("ratechange", () => { if (a === this.media) this.syncPositionState(); });
    a.addEventListener("error", () => { if (a === this.media) void this.onMediaError(); });
  }

  /** Read the episode again and go on from the same spot: for when its recording has changed (its video arrived). */
  async reload(): Promise<void> {
    // A channel's video that was only being looked at has arrived: now there is something to play.
    if (this.state.status === "details" && this.state.episodeId) {
      const id = this.state.episodeId;
      const ep = await unwrap(api.GET("/v1/episodes/{id}", { params: { path: { id } } }));
      if (this.state.episodeId === id && ep.asset) this.attach(ep, false);
      return;
    }
    return this.renewSource({ resume: this.state.playing });
  }

  /** Show the video element in this box, or send it back out of sight with null. Playback carries on either way. */
  placeVideo(box: HTMLElement | null): void {
    const v = this.videoEl;
    const wasPlaying = !v.paused;
    (box ?? this.videoHome).append(v);
    // appendChild moves the element in one step, which browsers should not treat as a removal; this covers one that does.
    if (wasPlaying && v.paused) void v.play().catch(() => undefined);
  }

  /** Full screen for the picture. Safari's own call comes first: iPhone Safari has only that one that works. */
  enterVideoFullscreen(): void {
    const v = this.videoEl as HTMLVideoElement & { webkitEnterFullscreen?: () => void };
    if (v.webkitEnterFullscreen) {
      // iOS pauses the video as its full-screen player closes, just before or just after it says so. Play on, unless
      // the pause came well before: that one was the owner's.
      let pausedAt = 0;
      const onPause = () => { pausedAt = Date.now(); };
      v.addEventListener("pause", onPause);
      v.addEventListener("webkitendfullscreen", () => {
        v.removeEventListener("pause", onPause);
        const resume = () => void v.play().catch(() => undefined);
        if (v.paused) {
          if (Date.now() - pausedAt < 1000) resume();
          return;
        }
        v.addEventListener("pause", resume, { once: true });
        window.setTimeout(() => v.removeEventListener("pause", resume), 1000);
      }, { once: true });
      v.webkitEnterFullscreen();
    } else void v.requestFullscreen?.().catch(() => undefined);
  }

  /** Whether a recording with a picture plays as video (the owner's choice, kept) or as sound only. */
  wantsVideo(): boolean {
    return readJson<boolean>(VIDEO_KEY, true);
  }
  /** Play video or sound only; a recording with a picture that is loaded switches at its current position. */
  setWantsVideo(on: boolean): void {
    writeJson(VIDEO_KEY, on);
    if (this.state.status === "ready" && this.state.episode?.asset?.video_url && this.state.video !== on) void this.renewSource({ resume: this.state.playing });
  }

  // ----- subscription -----
  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getState = (): PlayerState => this.state;
  private set(patch: Partial<PlayerState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  /** Call synchronously inside a tap before any await, so iOS lets the later play() through. */
  prime(): void {
    if (this.unlocked) return;
    this.unlocked = true;
    if (this.media.src) return;
    this.media.src = SILENT;
    this.media.play().catch(() => undefined);
  }

  /**
   * After a reload, put the player back on the episode this device was last listening to, paused at its position,
   * so the mini player shows it and one tap resumes. Does nothing if something is already loaded.
   */
  restoreLast(): void {
    if (this.state.status !== "idle") return;
    const last = readJson<LastPlayed | null>(LAST_KEY, null);
    if (!last || Date.now() - last.at > LAST_MAX_AGE_MS) return;
    void this.open(last.episodeId);
  }

  /** Load an episode (fetching its recording first when the server has none yet) and optionally start it. */
  async open(episodeId: string, opts: { autoplay?: boolean } = {}): Promise<void> {
    if (opts.autoplay) this.prime();
    if (this.state.episodeId === episodeId && this.state.status !== "error") {
      if (opts.autoplay && this.state.status === "ready") this.play();
      return;
    }
    const token = ++this.openToken;
    this.detach();
    this.set({ status: "loading", episodeId, episode: null, assetId: null, positionMs: 0, durationMs: 0, heardFromMs: 0, finished: false, playing: false, buffering: false, error: null });
    try {
      let ep = await unwrap(api.GET("/v1/episodes/{id}", { params: { path: { id: episodeId } } }));
      if (token !== this.openToken) return;
      // A channel's video opens on its details: the download is hours of the home connection, and only Fetch asks for it.
      if (!ep.asset && ep.media_kind === "video" && ep.youtube_id) {
        this.set({ status: "details", episode: ep, durationMs: ep.duration_ms ?? 0 });
        return;
      }
      if (!ep.asset) {
        ep = await unwrap(api.POST("/v1/episodes/{id}/audio", { params: { path: { id: episodeId } } }));
        if (token !== this.openToken) return;
        this.set({ status: "preparing", episode: ep, durationMs: ep.duration_ms ?? 0 });
        while (!ep.asset) {
          if (ep.processing.audio === "failed") throw new Error("The recording could not be fetched");
          await sleep(PREPARE_POLL_MS);
          if (token !== this.openToken) return;
          ep = await unwrap(api.GET("/v1/episodes/{id}", { params: { path: { id: episodeId } } }));
          if (token !== this.openToken) return;
        }
      }
      this.attach(ep, opts.autoplay ?? false);
    } catch (e) {
      if (token !== this.openToken) return;
      this.set({ status: "error", error: describeError(e) });
    }
  }

  setArtwork(url: string | null): void {
    if (url === this.state.artwork) return;
    this.set({ artwork: url });
    if (this.state.episode) this.setMetadata(this.state.episode);
  }

  /** Re-read the episode (new resume, transcript, chapters) without touching playback. */
  async refreshEpisode(): Promise<void> {
    const id = this.state.episode?.id;
    if (!id) return;
    const ep = await unwrap(api.GET("/v1/episodes/{id}", { params: { path: { id } } }));
    if (this.state.episode?.id === id) this.set({ episode: ep });
  }

  private attach(ep: EpisodeDetail, autoplay: boolean) {
    const asset = ep.asset;
    if (!asset) return;
    // The server's resume is the newest report from any device; this device's own last position wins when it is
    // newer, which covers the seconds between the last report and iOS discarding the page.
    const serverStart = ep.resume && !ep.resume.finished ? ep.resume.position_ms : 0;
    const last = readJson<LastPlayed | null>(LAST_KEY, null);
    // Newer wins outright: listening here after another device marked the episode played (re-listening to part of it)
    // must come back to that spot, not to the start.
    // Only on the same recording: a place in another cut means nothing here, and the server carries it over when it does.
    const localNewer = last && last.episodeId === ep.id && (!last.assetId || last.assetId === asset.id) && last.at > (ep.resume?.updated_at ?? 0);
    const start = localNewer ? (last.finished ? 0 : Math.min(last.positionMs, asset.duration_ms)) : serverStart;
    this.loading = true;
    this.renewedUrl = false;
    // The resume point is held like a seek: if the element starts from 0 regardless of the fragment, it is moved.
    this.pendingSeek = start > 0 ? { ms: start, tries: 0 } : null;
    this.heard.reset(start, { assumeHeardBeforeMs: RESUME_ASSUMED_HEARD_MS });
    const video = !!asset.video_url && this.wantsVideo();
    this.set({ status: "ready", episode: ep, assetId: asset.id, durationMs: asset.duration_ms, positionMs: start, heardFromMs: this.heard.heardFrom(start), finished: false, error: null, video });
    const a = this.media;
    this.idle(video ? this.audioEl : this.videoEl);
    // The media fragment starts playback at the resume point without a seek after metadata arrives.
    a.src = `${mediaPath(video ? asset.video_url! : asset.audio_url)}#t=${(start / 1000).toFixed(3)}`;
    a.playbackRate = this.state.speed;
    const onMeta = () => {
      a.removeEventListener("loadedmetadata", onMeta);
      // A seek made before the metadata arrived wins over the resume point.
      const want = this.state.positionMs;
      if (Math.abs(a.currentTime * 1000 - want) > 1500) a.currentTime = want / 1000;
      this.loading = false;
      if (Number.isFinite(a.duration) && a.duration > 0) this.set({ durationMs: Math.round(a.duration * 1000) });
    };
    a.addEventListener("loadedmetadata", onMeta);
    a.load();
    this.setMetadata(ep);
    if (autoplay) {
      // Safari fires play before metadata; events are ignored until then, so flip the flag ourselves.
      this.loading = false;
      this.play();
    }
  }

  /** Let go of an element's recording, so the one not in use holds no stream. */
  private idle(a: HTMLMediaElement) {
    if (!a.getAttribute("src")) return;
    a.pause();
    a.removeAttribute("src");
    a.load();
  }

  private detach() {
    if (this.state.assetId && this.state.status === "ready") {
      this.media.pause();
      this.report();
    }
    this.stopReporting();
    this.loading = true; // events from the old source are ignored until the next attach completes
  }

  // ----- transport -----
  play(): void {
    if (this.state.status !== "ready") return;
    // A source that failed while the page slept is reloaded at the same spot before playing. (Only a real media
    // error counts: the element's "no source" network state is also its transient state right after a load.)
    if (this.media.error) {
      void this.renewSource({ resume: true });
      return;
    }
    this.media.play().catch((e: unknown) => {
      this.set({ playing: false, error: e instanceof DOMException && e.name === "NotAllowedError" ? "Tap play to start" : describeError(e) });
    });
  }
  pause(): void {
    this.media.pause();
  }
  toggle(): void {
    if (this.state.playing) this.pause();
    else this.play();
  }
  seek(ms: number): void {
    if (this.state.status !== "ready") return;
    const to = Math.max(0, Math.min(ms, this.state.durationMs || ms));
    this.heard.jump(this.state.positionMs, to);
    this.pendingSeek = { ms: to, tries: 0 };
    this.media.currentTime = to / 1000;
    this.set({ positionMs: to, heardFromMs: this.heard.heardFrom(to), finished: false });
    this.report();
    this.syncPositionState();
  }
  skip(deltaMs: number): void {
    this.seek(this.state.positionMs + deltaMs);
  }
  setSpeed(speed: number): void {
    this.media.playbackRate = speed;
    writeJson(SPEED_KEY, speed);
    this.set({ speed });
    this.report();
  }
  cycleSpeed(): void {
    const i = SPEEDS.indexOf(this.state.speed);
    this.setSpeed(SPEEDS[(i + 1) % SPEEDS.length] ?? 1);
  }
  markFinished(): void {
    this.media.pause();
    this.set({ finished: true });
    this.report();
  }

  /** The four fields a snip needs, straight from the engine state. */
  snipPayload(): { asset_id: string; anchor_ms: number; heard_from_ms: number } | null {
    if (!this.state.assetId || this.state.status !== "ready") return null;
    const anchor = this.state.positionMs;
    return { asset_id: this.state.assetId, anchor_ms: anchor, heard_from_ms: this.heard.heardFrom(anchor) };
  }

  // ----- reporting -----
  private report(opts: { keepalive?: boolean } = {}) {
    const s = this.state;
    if (!s.assetId || s.status !== "ready" || this.loading) return;
    if (s.episode) writeJson(LAST_KEY, { episodeId: s.episode.id, assetId: s.assetId, positionMs: s.positionMs, at: Date.now(), finished: s.finished } satisfies LastPlayed);
    reportPlayback(s.assetId, { position_ms: s.positionMs, speed: s.speed, playing: s.playing, finished: s.finished }, opts);
  }
  private startReporting() {
    this.stopReporting();
    this.reportTimer = window.setInterval(() => this.report(), REPORT_EVERY_MS);
  }
  private stopReporting() {
    if (this.reportTimer !== null) window.clearInterval(this.reportTimer);
    this.reportTimer = null;
  }

  // ----- media errors and stale sources (an expired signed URL shows up here) -----
  private async onMediaError() {
    if (this.loading || !this.state.episode || this.renewedUrl) {
      if (!this.loading && this.state.status === "ready") this.set({ error: "Playback failed", playing: false });
      return;
    }
    await this.renewSource({ resume: this.state.playing });
  }

  /** Fetch a fresh signed URL and reload the recording at the current position, optionally playing on. */
  private async renewSource(opts: { resume: boolean }): Promise<void> {
    if (!this.state.episode) return;
    this.renewedUrl = true;
    const at = this.state.positionMs;
    try {
      const ep = await unwrap(api.GET("/v1/episodes/{id}", { params: { path: { id: this.state.episode.id } } }));
      if (!ep.asset) throw new Error("recording missing");
      this.loading = true;
      const video = !!ep.asset.video_url && this.wantsVideo();
      const was = this.media;
      // The recording may have changed (its video arrived): reports and snips go to the one now playing.
      this.set({ episode: ep, assetId: ep.asset.id, durationMs: ep.asset.duration_ms, error: null, video });
      const a = this.media;
      if (was !== a) this.idle(was);
      a.src = `${mediaPath(video ? ep.asset.video_url! : ep.asset.audio_url)}#t=${(at / 1000).toFixed(3)}`;
      // As in attach: the fragment should start at the wanted position, and the metadata guard seeks there if it did
      // not; a seek made meanwhile wins.
      const onMeta = () => {
        a.removeEventListener("loadedmetadata", onMeta);
        const want = this.state.positionMs;
        if (Math.abs(a.currentTime * 1000 - want) > 1500) a.currentTime = want / 1000;
      };
      a.addEventListener("loadedmetadata", onMeta);
      a.load();
      this.loading = false;
      if (opts.resume) {
        a.play().catch((e: unknown) => {
          this.set({ playing: false, error: e instanceof DOMException && e.name === "NotAllowedError" ? "Tap play to start" : describeError(e) });
        });
      }
    } catch (e) {
      this.set({ error: describeError(e), playing: false });
    }
  }

  /** Back from the background: catch up on position, and swap in a fresh URL if the old one is about to expire. */
  private onVisible() {
    if (this.state.status !== "ready" || this.loading) return;
    const pos = Math.round(this.media.currentTime * 1000);
    if (Number.isFinite(pos) && pos > 0 && Math.abs(pos - this.state.positionMs) > 1000) this.set({ positionMs: pos });
    if (this.state.playing) return;
    const url = this.state.episode?.asset?.audio_url;
    const expires = url ? Number(new URL(url, location.href).searchParams.get("e")) : NaN;
    if (this.media.error || (Number.isFinite(expires) && expires - Date.now() / 1000 < URL_RENEW_MARGIN_S)) void this.renewSource({ resume: false });
  }

  // ----- Media Session (lock screen, headphones) -----
  private installMediaSession() {
    const ms = navigator.mediaSession;
    if (!ms) return;
    const set = (action: MediaSessionAction, handler: MediaSessionActionHandler) => {
      try { ms.setActionHandler(action, handler); } catch { /* unsupported action */ }
    };
    set("play", () => this.play());
    set("pause", () => this.pause());
    set("seekbackward", (d) => this.skip(-((d.seekOffset ?? 15) * 1000)));
    set("seekforward", (d) => this.skip((d.seekOffset ?? 30) * 1000));
    set("seekto", (d) => { if (d.seekTime !== undefined) this.seek(d.seekTime * 1000); });
    set("stop", () => this.pause());
  }
  private setMetadata(ep: EpisodeDetail) {
    const ms = navigator.mediaSession;
    if (!ms || typeof MediaMetadata === "undefined") return;
    const art = ep.image_url ?? this.state.artwork;
    ms.metadata = new MediaMetadata({ title: ep.title, artist: ep.show_title ?? "", album: ep.show_title ?? "", artwork: art ? [{ src: art }] : [] });
  }
  private syncPositionState() {
    const ms = navigator.mediaSession;
    if (!ms || !ms.setPositionState || this.loading) return;
    const a = this.media;
    if (!Number.isFinite(a.duration) || a.duration <= 0) return;
    try {
      ms.setPositionState({ duration: a.duration, playbackRate: a.playbackRate, position: Math.min(a.currentTime, a.duration) });
    } catch { /* ignore */ }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
