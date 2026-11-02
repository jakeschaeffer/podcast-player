/**
 * What the listener has actually heard of the current recording, so a snip never reaches back into audio that
 * was skipped, and never loses audio that was heard just because the listener jumped around inside it.
 *
 * Played stretches are kept as merged intervals. A snip's `heard_from_ms` is the start of the heard stretch that
 * contains the tap: skipping back 15 s inside audio already played keeps the whole stretch; skipping forward past
 * unheard audio starts a new one.
 */

/** Stretches closer together than this count as one (timer granularity, tiny seeks). */
export const MERGE_GAP_MS = 2_000;
/** A position jump this much beyond what playback time explains is a seek nobody told us about. */
const JUMP_TOLERANCE_MS = 3_000;

type Range = [number, number];

export class HeardTracker {
  private ranges: Range[] = [];
  private runStart = 0;
  private lastPos = 0;
  private lastWall: number | null = null;

  /**
   * Start over for a newly loaded recording at `startMs`. `assumeHeardBeforeMs` marks that much audio before the
   * start as heard: used for a resume point, which is where the listener stopped listening.
   */
  reset(startMs: number, opts: { assumeHeardBeforeMs?: number } = {}): void {
    this.ranges = [];
    const before = opts.assumeHeardBeforeMs ?? 0;
    if (before > 0 && startMs > 0) this.ranges.push([Math.max(0, startMs - before), startMs]);
    this.runStart = startMs;
    this.lastPos = startMs;
    this.lastWall = null;
  }

  /** A deliberate jump: skip buttons, scrubbing, a chapter or transcript tap, lock-screen seek. */
  jump(fromMs: number, toMs: number): void {
    this.closeRun(fromMs);
    this.runStart = toMs;
    this.lastPos = toMs;
    this.lastWall = null;
  }

  /**
   * A position update (the media element's timeupdate). Detects jumps that did not come through `jump()`, such as
   * native controls, while ignoring stalls: buffering advances wall time but not position, which is not a jump.
   */
  tick(posMs: number, playing: boolean, speed: number, wallMs: number): void {
    const delta = posMs - this.lastPos;
    let jumped: boolean;
    if (playing && this.lastWall !== null) {
      const expected = Math.max(0, wallMs - this.lastWall) * speed;
      jumped = delta < -1_000 || delta > expected + JUMP_TOLERANCE_MS;
    } else {
      jumped = Math.abs(delta) > JUMP_TOLERANCE_MS;
    }
    if (jumped) {
      this.closeRun(this.lastPos);
      this.runStart = posMs;
    }
    this.lastPos = posMs;
    this.lastWall = playing ? wallMs : null;
  }

  /** Start of the heard stretch containing `posMs`; `posMs` itself when nothing before it was heard. */
  heardFrom(posMs: number): number {
    const all = merge([...this.ranges, [this.runStart, Math.max(this.runStart, posMs)]]);
    for (const [start, end] of all) {
      if (start <= posMs && posMs <= end + MERGE_GAP_MS) return Math.min(start, posMs);
    }
    return posMs;
  }

  /** For debugging and tests. */
  heardRanges(posMs: number): Range[] {
    return merge([...this.ranges, [this.runStart, Math.max(this.runStart, posMs)]]);
  }

  private closeRun(endMs: number): void {
    if (endMs > this.runStart) this.ranges = merge([...this.ranges, [this.runStart, endMs]]);
  }
}

function merge(ranges: Range[]): Range[] {
  const sorted = ranges.filter(([s, e]) => e >= s).sort((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1] + MERGE_GAP_MS) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}
