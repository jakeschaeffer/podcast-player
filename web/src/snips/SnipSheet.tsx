import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { Chapter, Snip } from "../api/types";
import { Icon } from "../components/Icon";
import { useToast } from "../components/Toast";
import { copyText } from "../lib/clipboard";
import { navigate } from "../lib/router";
import { clock, spanLength } from "../lib/time";
import { chapterAt } from "../lib/transcript";
import { clipPlayer, usePlayingClip } from "./clipPlayer";
import type { PendingSnip } from "./outbox";
import { TitleEdit } from "./TitleEdit";
import { isPending, useSnip } from "./useSnip";

export type SheetState = { kind: "waiting"; pending: PendingSnip } | { kind: "snip"; id: string; initial: Snip | null };

// The card survives leaving the player (to the editor, say) and comes back for the same episode.
let remembered: { episodeId: string; state: SheetState } | null = null;
export function rememberSheet(episodeId: string, state: SheetState | null): void {
  remembered = state ? { episodeId, state } : null;
}
export function recallSheet(episodeId: string): SheetState | null {
  return remembered?.episodeId === episodeId ? { ...remembered.state, ...(remembered.state.kind === "snip" ? { initial: null } : {}) } as SheetState : null;
}

/** Dragging the card down this far dismisses it. */
const DISMISS_DRAG_PX = 70;

/**
 * The compact result card at the bottom of the player: title, span, Play clip / Edit / Copy link, and a status line
 * only while the snip is still on its way (preparing, waiting to send) or failed. Once the moment is chosen, a tap on
 * the title edits it in place.
 * It never blocks listening: close it with the × button, by swiping it down, or with Escape.
 */
export function SnipSheet({ state, chapters, onClose, onSnipChange }: { state: SheetState; chapters: Chapter[] | undefined; onClose: () => void; onSnipChange?: (s: Snip) => void }) {
  const id = state.kind === "snip" ? state.id : null;
  const { snip, error, refresh } = useSnip(id, state.kind === "snip" ? state.initial : null);
  const toast = useToast();
  const playingClip = usePlayingClip();
  const [dragY, setDragY] = useState(0);
  const drag = useRef<{ startY: number; pointerId: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // An Escape the title's text box handled only ends the edit.
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Swipe down to dismiss. Drags start anywhere on the card but only follow downward movement. A mouse selects text
  // and uses the × instead.
  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    if (e.pointerType === "mouse" || (e.target as HTMLElement).closest("textarea")) return;
    drag.current = { startY: e.clientY, pointerId: e.pointerId };
  };
  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dy = Math.max(0, e.clientY - d.startY);
    if (dy > 6 && !e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.setPointerCapture(e.pointerId);
    setDragY(dy);
  };
  const onPointerEnd = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    const dy = Math.max(0, e.clientY - d.startY);
    setDragY(0);
    if (dy >= DISMISS_DRAG_PX) onClose();
  };

  useEffect(() => {
    if (snip && onSnipChange) onSnipChange(snip);
  }, [snip, onSnipChange]);

  const rev = snip?.revision ?? null;
  const pending = state.kind === "waiting" || isPending(snip) || (!snip && !error);
  const failed = rev?.status === "failed";
  const anchor = state.kind === "waiting" ? state.pending.anchor_ms : (snip?.anchor_ms ?? 0);
  const chapter = chapterAt(chapters, rev ? rev.end_ms : anchor);
  const span = rev ? `${clock(rev.start_ms)} – ${clock(rev.end_ms)} (${spanLength(rev.end_ms - rev.start_ms)})` : `at ${clock(anchor)}`;

  async function copy() {
    if (!snip) return;
    const how = await copyText(snip.share_url);
    if (how === "copied") toast("Link copied");
  }

  return (
    <section
      className="sheet sheet--snip"
      aria-label="Snip saved"
      aria-live="polite"
      style={dragY > 0 ? { transform: `translateY(${dragY}px)`, transition: "none" } : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      <button className="sheet__handle-btn" onClick={onClose} aria-label="Dismiss snip card">
        <span className="sheet__handle" />
      </button>
      <button className="icon-btn sheet__close" onClick={onClose} aria-label="Close snip card">
        <Icon name="close" size={22} strokeWidth={2.2} />
      </button>
      {/* Only news gets a status line: still preparing, waiting to send, or failed. A ready snip shows just its title. */}
      {(state.kind === "waiting" || pending || failed) && (
        <div className="sheet__states">
          {state.kind === "waiting" ? (
            <span className="state state--pending">
              <Icon name="clock" size={18} />
              Waiting for connection
            </span>
          ) : failed ? (
            <span className="state state--failed">
              <Icon name="alert" size={19} strokeWidth={2.2} />
              Snip failed{rev?.error ? `: ${rev.error}` : ""}
            </span>
          ) : (
            <span className="state state--pending">
              <Icon name="clock" size={18} />
              {rev?.status === "waiting" ? "Waiting for transcript" : "Preparing public clip"}
            </span>
          )}
        </div>
      )}
      <div className="sheet__body">
        {snip && rev?.title && !failed && rev.status !== "waiting" && rev.status !== "selecting" ? (
          <TitleEdit snip={snip} onSaved={() => void refresh()} className="sheet__title" />
        ) : (
          <div className="sheet__title">{rev?.title ?? (pending ? "Choosing the moment…" : "Snip")}</div>
        )}
        <div className="sheet__span tnum">
          {span}
          {chapter ? ` · ${chapter.title}` : ""}
        </div>
        {error && <div className="error">{error}</div>}
      </div>
      <div className="btn-grid-3" style={{ marginTop: 2 }}>
        <button className="btn btn--soft" disabled={!rev?.clip_url} onClick={() => rev?.clip_url && clipPlayer.toggle(rev.id, rev.clip_url)} aria-pressed={playingClip === rev?.id}>
          <Icon name={playingClip === rev?.id ? "stop" : snip?.media_kind === "video" ? "video" : "play"} size={16} />
          {playingClip === rev?.id ? "Stop" : "Play clip"}
        </button>
        <button className="btn btn--soft" disabled={!snip || pending || failed} onClick={() => snip && navigate(`/snips/${snip.id}/edit`)}>
          <Icon name="edit" size={17} />
          Edit
        </button>
        <button className="btn btn--soft" disabled={!snip} onClick={() => void copy()}>
          <Icon name="link" size={17} />
          Copy link
        </button>
      </div>
    </section>
  );
}
