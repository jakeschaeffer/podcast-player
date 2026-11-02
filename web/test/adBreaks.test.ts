import { describe, expect, it } from "vitest";
import { AD_SKIP_TAIL_MS, adBreakAt, type AdBreak } from "../src/lib/adBreaks";

const ad = (start_ms: number, end_ms: number): AdBreak => ({ start_ms, end_ms, confidence: "high", sources: ["publisher_gap"], cue: null });

describe("adBreakAt", () => {
  const breaks = [ad(0, 30_000), ad(600_000, 660_000)];

  it("offers a skip from a break's first moment until just before it ends", () => {
    expect(adBreakAt(breaks, 0)).toBe(breaks[0]);
    expect(adBreakAt(breaks, 30_000 - AD_SKIP_TAIL_MS - 1)).toBe(breaks[0]);
    expect(adBreakAt(breaks, 30_000 - AD_SKIP_TAIL_MS)).toBeNull();
    expect(adBreakAt(breaks, 599_999)).toBeNull();
    expect(adBreakAt(breaks, 630_000)).toBe(breaks[1]);
    expect(adBreakAt(breaks, 660_000)).toBeNull();
  });

  it("offers nothing without breaks", () => {
    expect(adBreakAt(undefined, 10_000)).toBeNull();
    expect(adBreakAt([], 10_000)).toBeNull();
  });
});
