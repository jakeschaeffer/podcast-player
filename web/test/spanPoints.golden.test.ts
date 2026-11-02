/**
 * Golden cases for the snip editor's In/Out rules (web/src/lib/spanPoints.ts): where a point lands, when it carries
 * the other point along, and which words count as inside a span. Native editors must give the same answers.
 */
import { describe, expect, it } from "vitest";
import { MIN_SPAN_MS, setSpanPoint, wordInSpan, type Point, type Span } from "../src/lib/spanPoints";
import { golden, lcg } from "./golden";

type SetCase = { span: Span; point: Point; ms: number; duration_ms: number; expect: Span };
type WordCase = { word: [number, number]; span: Span; expect: boolean };

const DURATION = 600_000;
const spans: Span[] = [
  { start_ms: 100_000, end_ms: 190_000 },
  { start_ms: 0, end_ms: 1_000 },
  { start_ms: 598_000, end_ms: 600_000 },
  { start_ms: 50_000, end_ms: 50_500 }, // shorter than the minimum (an old revision)
];
const targets = [-5_000, 0, 500, 99_000, 100_000, 150_000, 189_500, 190_000, 250_000, 599_500, 600_000, 700_000];

const setCases: SetCase[] = [];
for (const span of spans) for (const point of ["in", "out"] as Point[]) for (const ms of targets) {
  setCases.push({ span, point, ms, duration_ms: DURATION, expect: setSpanPoint(span, point, ms, DURATION) });
}
const r = lcg(7);
for (let i = 0; i < 40; i++) {
  const duration = 30_000 + Math.floor(r() * 7_200_000);
  const start = Math.floor(r() * duration);
  const span = { start_ms: start, end_ms: Math.min(duration, start + Math.floor(r() * 200_000)) };
  const point: Point = r() < 0.5 ? "in" : "out";
  const ms = Math.floor((r() * 1.2 - 0.1) * duration);
  setCases.push({ span, point, ms, duration_ms: duration, expect: setSpanPoint(span, point, ms, duration) });
}

const span = { start_ms: 10_000, end_ms: 20_000 };
const words: [number, number][] = [[9_000, 10_000], [9_500, 10_500], [9_600, 10_500], [19_500, 20_500], [19_600, 20_500], [20_000, 20_000], [15_000, 15_000], [21_000, 22_000]];
const wordCases: WordCase[] = words.map((word) => ({ word, span, expect: wordInSpan(word, span) }));

describe("span_points_v1 golden cases", () => {
  it("behave as intended", () => {
    const find = (s: Span, point: Point, ms: number) => setCases.find((c) => c.span === s && c.point === point && c.ms === ms)!.expect;
    expect(find(spans[0]!, "in", 150_000)).toEqual({ start_ms: 150_000, end_ms: 190_000 }); // inside: Out stays
    expect(find(spans[0]!, "in", 250_000)).toEqual({ start_ms: 250_000, end_ms: 340_000 }); // past Out: carries it, keeps 90 s
    expect(find(spans[0]!, "out", 99_000)).toEqual({ start_ms: 9_000, end_ms: 99_000 }); // before In: carries it back
    expect(find(spans[0]!, "out", 700_000)).toEqual({ start_ms: 100_000, end_ms: DURATION }); // clamped to the recording
    expect(find(spans[0]!, "in", -5_000)).toEqual({ start_ms: 0, end_ms: 190_000 });
    for (const c of setCases) expect(c.expect.end_ms - c.expect.start_ms).toBeGreaterThanOrEqual(Math.min(MIN_SPAN_MS, c.duration_ms));
    expect(wordCases.map((c) => c.expect)).toEqual([false, true, true, true, false, true, true, false]);
  });

  it("match the committed file", () => {
    const file = { family: "span-points", version: "span_points_v1", reference: "web/src/lib/spanPoints.ts", min_span_ms: MIN_SPAN_MS, set_point: setCases, word_in_span: wordCases };
    expect(golden("span-points/span_points_v1.json", file)).toEqual(file);
  });
});
