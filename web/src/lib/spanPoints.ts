/**
 * The snip editor's rules for In and Out, kept out of the component so they can be tested and ported: the native
 * apps implement the same rules and check them against contracts/golden/span-points.
 */

export type Point = "in" | "out";
export type Span = { start_ms: number; end_ms: number };

/** The shortest span the editor allows. */
export const MIN_SPAN_MS = 1_000;

/** Whether a word belongs to the span: its midpoint lies inside it, both ends included. */
export function wordInSpan(word: readonly [number, number, ...unknown[]], span: Span): boolean {
  const mid = (word[0] + word[1]) / 2;
  return mid >= span.start_ms && mid <= span.end_ms;
}

/**
 * Put `point` at `ms`. Moving In past Out (or Out before In) carries the other point along, keeping the snip's
 * length, so a tap far from the current span starts a new span there instead of collapsing to one second.
 */
export function setSpanPoint(span: Span, point: Point, ms: number, durationMs: number): Span {
  const len = Math.max(MIN_SPAN_MS, span.end_ms - span.start_ms);
  if (point === "in") {
    const start = Math.max(0, Math.min(ms, durationMs - MIN_SPAN_MS));
    return { start_ms: start, end_ms: start > span.end_ms - MIN_SPAN_MS ? Math.min(durationMs, start + len) : span.end_ms };
  }
  const end = Math.min(durationMs, Math.max(ms, MIN_SPAN_MS));
  return { start_ms: end < span.start_ms + MIN_SPAN_MS ? Math.max(0, end - len) : span.start_ms, end_ms: end };
}
