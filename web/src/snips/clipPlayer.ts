import { useSyncExternalStore } from "react";
import { mediaPath } from "../lib/media";
import type { PlayerEngine } from "../player/engine";

/**
 * One shared element for clip previews (snip cards, the snips list). Previews never report playback;
 * the main player is paused while a clip plays and resumed afterwards if it was playing.
 */
const audio = new Audio();
let playingId: string | null = null;
let resumeMain = false;
let engineRef: PlayerEngine | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}
function finish() {
  playingId = null;
  emit();
  if (resumeMain && engineRef) engineRef.play();
  resumeMain = false;
}
audio.addEventListener("ended", finish);
audio.addEventListener("pause", () => {
  if (playingId) finish();
});
audio.addEventListener("error", finish);

export const clipPlayer = {
  attachEngine(e: PlayerEngine) {
    engineRef = e;
  },
  toggle(id: string, url: string) {
    if (playingId === id) {
      audio.pause();
      return;
    }
    if (engineRef?.getState().playing) {
      resumeMain = true;
      engineRef.pause();
    }
    playingId = id;
    audio.src = mediaPath(url);
    emit();
    audio.play().catch(finish);
  },
  /** Stop the preview. `resumeMain: false` keeps the episode paused even if the preview had paused it. */
  stop(opts: { resumeMain?: boolean } = {}) {
    if (opts.resumeMain === false) resumeMain = false;
    if (playingId) audio.pause();
  },
};

export function usePlayingClip(): string | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => playingId,
    () => playingId,
  );
}
