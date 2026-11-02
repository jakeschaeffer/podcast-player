import type { Span } from "./spanPoints";

/**
 * Undo and redo for the editor's In and Out: each change records the span it replaced, undo steps back to it, and
 * redo steps forward again until the next change starts a new branch.
 */
export class SpanHistory {
  private undos: Span[] = [];
  private redos: Span[] = [];

  /** `before` was the span until a change just replaced it. */
  record(before: Span): void {
    this.undos.push(before);
    this.redos = [];
  }

  /** The span to go back to from `current`, or null with nothing to undo. */
  undo(current: Span): Span | null {
    const back = this.undos.pop();
    if (back) this.redos.push(current);
    return back ?? null;
  }

  /** The span an undo left behind, or null with nothing to redo. */
  redo(current: Span): Span | null {
    const again = this.redos.pop();
    if (again) this.undos.push(current);
    return again ?? null;
  }
}
