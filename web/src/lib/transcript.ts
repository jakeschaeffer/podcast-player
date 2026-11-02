import type { Chapter, Segment } from "../api/types";

/** Index of the segment playing at `ms` (the last one whose start is ≤ ms), or -1 before the first. */
export function segmentIndexAt(segments: Segment[], ms: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((segments[mid]?.s ?? 0) <= ms) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

/** Index of the word playing at `ms` inside a segment, or -1. */
export function wordIndexAt(seg: Segment, ms: number): number {
  let best = -1;
  for (let i = 0; i < seg.words.length; i++) {
    const w = seg.words[i];
    if (w && w[0] <= ms) best = i;
    else break;
  }
  return best;
}

export function chapterAt(chapters: Chapter[] | undefined, ms: number): Chapter | undefined {
  if (!chapters || chapters.length === 0) return undefined;
  let found: Chapter | undefined;
  for (const c of chapters) {
    if (c.start_ms <= ms) found = c;
    else break;
  }
  return found;
}
