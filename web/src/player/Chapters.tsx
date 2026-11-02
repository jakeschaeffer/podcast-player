import type { Chapter } from "../api/types";
import { clock } from "../lib/time";

export function Chapters({ chapters, positionMs, onSeek }: { chapters: Chapter[]; positionMs: number; onSeek: (ms: number) => void }) {
  if (chapters.length === 0) return <p className="empty">No chapters for this episode yet.</p>;
  const currentIdx = chapters.reduce((acc, c, i) => (c.start_ms <= positionMs ? i : acc), -1);
  return (
    <ul className="chapters" aria-label="Chapters">
      {chapters.map((c, i) => (
        <li key={i} className={i === currentIdx ? "is-current" : undefined} aria-current={i === currentIdx ? "true" : undefined}>
          <button onClick={() => onSeek(c.start_ms)}>
            <time className="tnum">{clock(c.start_ms)}</time>
            <span>
              <span className="chapters__title">{c.title}</span>
              {c.description && <span className="chapters__desc">{c.description}</span>}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
