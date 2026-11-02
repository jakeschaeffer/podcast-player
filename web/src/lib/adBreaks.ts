import type { EpisodeDetail } from "../api/types";

export type AdBreak = EpisodeDetail["ad_breaks"][number];

/** No skip is offered in a break's last moments: by the time the button could be pressed, the ad is over. */
export const AD_SKIP_TAIL_MS = 1_500;

/**
 * The suspected ad break playing at `positionMs`, if any: the one "Skip ad" would leave. Breaks are never skipped
 * automatically; this only decides when the button shows.
 */
export function adBreakAt(breaks: readonly AdBreak[] | null | undefined, positionMs: number): AdBreak | null {
  for (const b of breaks ?? []) if (positionMs >= b.start_ms && positionMs < b.end_ms - AD_SKIP_TAIL_MS) return b;
  return null;
}
