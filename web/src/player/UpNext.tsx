import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { EpisodeListItem } from "../api/types";
import { Artwork } from "../components/Artwork";
import { Icon } from "../components/Icon";
import { useToast } from "../components/Toast";
import { describeError } from "../api/client";
import { navigate } from "../lib/router";
import { clock, minutes } from "../lib/time";
import { useQuery } from "../lib/useQuery";
import { useFeeds } from "../screens/Today";
import { useEngine } from "./PlayerContext";
import { fetchQueue, QUEUE_KEY, removeFromQueue, reorderQueue } from "./queue";

/** Where a row being dragged by its handle started, how far it has moved, and how tall a row is. */
type Drag = { id: string; pointerId: number; startY: number; dy: number; from: number; rowH: number };

/**
 * Up next in the player: the episodes that play after this one, in order. Drag a row by its handle (mouse or touch),
 * or focus the handle and press the up and down arrows, to move it; the × takes one out (playing it again brings it
 * back). Clicking a row opens that episode without playing it.
 */
export function UpNext({ currentId }: { currentId: string }) {
  const engine = useEngine();
  const toast = useToast();
  const q = useQuery<EpisodeListItem[]>(QUEUE_KEY, fetchQueue);
  const feeds = useFeeds();
  const artwork = (e: EpisodeListItem) => e.image_url ?? feeds.data?.find((f) => f.id === e.feed_id)?.image_url ?? null;
  const items = (q.data ?? []).filter((e) => e.id !== currentId);
  const [drag, setDrag] = useState<Drag | null>(null);
  const list = useRef<HTMLOListElement>(null);

  /** Show the new order at once, then save it; a failed save puts back the server's order. */
  async function save(order: EpisodeListItem[]) {
    q.mutate((prev) => [...(prev ?? []).filter((e) => e.id === currentId), ...order]);
    try {
      q.mutate(await reorderQueue(order.map((e) => e.id)));
    } catch (e) {
      toast(describeError(e));
      void q.reload();
    }
  }

  function moved(from: number, to: number): EpisodeListItem[] {
    const next = [...items];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    return next;
  }

  const target = (d: Drag) => Math.max(0, Math.min(items.length - 1, d.from + Math.round(d.dy / d.rowH)));

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>, id: string, from: number) => {
    const row = e.currentTarget.closest("li");
    if (!row) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ id, pointerId: e.pointerId, startY: e.clientY, dy: 0, from, rowH: row.getBoundingClientRect().height });
  };
  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    if (!drag || drag.pointerId !== e.pointerId) return;
    setDrag({ ...drag, dy: e.clientY - drag.startY });
  };
  const onPointerUp = (e: PointerEvent<HTMLButtonElement>) => {
    if (!drag || drag.pointerId !== e.pointerId) return;
    const to = target(drag);
    setDrag(null);
    if (to !== drag.from) void save(moved(drag.from, to));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const to = e.key === "ArrowUp" ? index - 1 : e.key === "ArrowDown" ? index + 1 : null;
    if (to === null || to < 0 || to >= items.length) return;
    e.preventDefault();
    void save(moved(index, to));
    // Keep the focus on the handle of the row that moved.
    requestAnimationFrame(() => list.current?.querySelectorAll<HTMLButtonElement>(".upnext__grip")[to]?.focus());
  };

  async function remove(item: EpisodeListItem) {
    q.mutate((prev) => (prev ?? []).filter((e) => e.id !== item.id));
    try {
      q.mutate(await removeFromQueue(item.id));
    } catch (e) {
      toast(describeError(e));
      void q.reload();
    }
  }

  if (q.loading && !q.data) return <p className="upnext__note">Loading…</p>;
  if (items.length === 0) {
    return <p className="upnext__note">Nothing up next. Add episodes from a show or Today, or leave one partway through, and they line up here.</p>;
  }

  // While dragging, the rows between the start and the target make room by one row's height.
  const to = drag ? target(drag) : -1;
  const shift = (i: number): number => {
    if (!drag || i === drag.from) return 0;
    if (drag.from < to && i > drag.from && i <= to) return -drag.rowH;
    if (drag.from > to && i < drag.from && i >= to) return drag.rowH;
    return 0;
  };

  return (
    <>
      <p className="upnext__note">{items.length > 1 ? "Plays in this order when this episode ends. Drag the handle to move one." : "Plays when this episode ends."}</p>
      <ol className="upnext" ref={list}>
        {items.map((e, i) => {
          const dragging = drag?.id === e.id;
          const left = e.resume && !e.resume.finished && e.resume.position_ms > 0 && e.duration_ms ? `${clock(e.duration_ms - e.resume.position_ms)} left` : minutes(e.duration_ms);
          return (
            <li
              key={e.id}
              className={`upnext__row${dragging ? " upnext__row--dragging" : ""}`}
              style={{ transform: `translateY(${dragging ? drag.dy : shift(i)}px)`, transition: dragging || !drag ? "none" : "transform 0.15s ease" }}
            >
              <button
                className="upnext__grip"
                aria-label={`Move ${e.title}. Use the up and down arrows.`}
                onPointerDown={(ev) => onPointerDown(ev, e.id, i)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={() => setDrag(null)}
                onKeyDown={(ev) => onKeyDown(ev, i)}
              >
                <Icon name="grip" size={22} />
              </button>
              <a
                className="upnext__link"
                href={`/episodes/${e.id}`}
                onClick={(ev) => { ev.preventDefault(); void engine.open(e.id); navigate(`/episodes/${e.id}`); }}
              >
                <Artwork src={artwork(e)} size={52} radius={10} />
                <span className="upnext__body">
                  <span className="upnext__title">{e.title}</span>
                  <span className="upnext__meta">{[e.show_title, left].filter(Boolean).join(" · ")}</span>
                </span>
              </a>
              <button className="icon-btn" onClick={() => void remove(e)} aria-label={`Remove ${e.title} from Up next`}>
                <Icon name="close" size={20} />
              </button>
            </li>
          );
        })}
      </ol>
    </>
  );
}
