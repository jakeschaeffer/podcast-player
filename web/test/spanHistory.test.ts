import { describe, expect, it } from "vitest";
import { SpanHistory } from "../src/lib/spanHistory";

const s = (start_ms: number, end_ms: number) => ({ start_ms, end_ms });

describe("SpanHistory", () => {
  it("undoes changes in reverse order and redoes them forward", () => {
    const h = new SpanHistory();
    h.record(s(0, 10)); // → (2, 10)
    h.record(s(2, 10)); // → (2, 8)
    expect(h.undo(s(2, 8))).toEqual(s(2, 10));
    expect(h.undo(s(2, 10))).toEqual(s(0, 10));
    expect(h.undo(s(0, 10))).toBeNull();
    expect(h.redo(s(0, 10))).toEqual(s(2, 10));
    expect(h.redo(s(2, 10))).toEqual(s(2, 8));
    expect(h.redo(s(2, 8))).toBeNull();
  });

  it("drops what was undone once a new change is made", () => {
    const h = new SpanHistory();
    h.record(s(0, 10)); // → (2, 10)
    expect(h.undo(s(2, 10))).toEqual(s(0, 10));
    h.record(s(0, 10)); // → (0, 6)
    expect(h.redo(s(0, 6))).toBeNull();
    expect(h.undo(s(0, 6))).toEqual(s(0, 10));
  });
});
