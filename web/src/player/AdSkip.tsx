import { adBreakAt, type AdBreak } from "../lib/adBreaks";
import { Icon } from "../components/Icon";

/**
 * "Skip ad", shown only while a suspected ad break plays, like a streaming app's "Skip intro". It floats over the
 * layout (it never moves the controls) and fades in and out; pressing it seeks past the break. Never automatic.
 */
export function AdSkip({ breaks, positionMs, onSkip, disabled, className = "" }: { breaks: readonly AdBreak[] | undefined; positionMs: number; onSkip: (ms: number) => void; disabled?: boolean; className?: string }) {
  const current = adBreakAt(breaks, positionMs);
  const shown = current !== null && !disabled;
  const left = current ? Math.max(1, Math.round((current.end_ms - positionMs) / 1000)) : 0;
  return (
    <button
      className={`ad-skip${shown ? " is-on" : ""} ${className}`}
      onClick={() => current && onSkip(current.end_ms)}
      aria-hidden={!shown}
      tabIndex={shown ? 0 : -1}
      aria-label={shown ? `Skip ad, ${left} seconds` : undefined}
    >
      Skip ad
      <Icon name="chevronRight" size={18} strokeWidth={2.6} />
    </button>
  );
}
