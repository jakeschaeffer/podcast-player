import { normalize } from "../../src/core/transcript/normalize.js";
import type { NormalizedTranscript, RawWord } from "../../src/core/transcript/types.js";

export type Turn = {
  speaker?: string;
  text: string;
  /** Silence before this turn, ms. */
  pause_ms?: number;
  /** Words per second for this turn. */
  wps?: number;
};

/**
 * Lay turns out on a timeline and normalize them. Words within a turn are evenly spaced with a
 * 60 ms gap; sentences inside a turn get an extra 300 ms gap after terminal punctuation.
 */
export function buildTranscript(turns: Turn[], opts: { start_ms?: number } = {}): NormalizedTranscript {
  let t = opts.start_ms ?? 0;
  const words: RawWord[] = [];
  for (const turn of turns) {
    t += turn.pause_ms ?? 800;
    const wps = turn.wps ?? 2.5;
    const dur = Math.round(1000 / wps) - 60;
    for (const text of turn.text.split(/\s+/).filter(Boolean)) {
      const w: RawWord = { text, start_ms: t, end_ms: t + dur };
      if (turn.speaker) w.speaker = turn.speaker;
      words.push(w);
      t += dur + 60;
      if (/[.!?]$/.test(text)) t += 300;
    }
  }
  return normalize({ provider: "test", model: "builder", language: "eng", words, events: [] });
}

/** Deterministic pseudo-random generator for property-style tests. */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const FILLER = ["the", "team", "shipped", "a", "new", "version", "of", "the", "product", "and", "customers", "noticed", "the", "difference", "right", "away", "because", "latency", "dropped", "by", "half"];

/** A long two-speaker conversation with varied sentence lengths, questions, and pauses. */
export function conversation(seed: number, minutes: number): NormalizedTranscript {
  const rand = lcg(seed);
  const turns: Turn[] = [];
  let speaker = "A";
  let elapsed = 0;
  while (elapsed < minutes * 60_000) {
    const sentences = 1 + Math.floor(rand() * 4);
    const parts: string[] = [];
    for (let i = 0; i < sentences; i++) {
      const n = 3 + Math.floor(rand() * 18);
      const ws: string[] = [];
      for (let k = 0; k < n; k++) ws.push(FILLER[Math.floor(rand() * FILLER.length)]!);
      ws[0] = ws[0]![0]!.toUpperCase() + ws[0]!.slice(1);
      parts.push(ws.join(" ") + (rand() < 0.15 ? "?" : "."));
    }
    const text = parts.join(" ");
    const pause_ms = 300 + Math.floor(rand() * 2500);
    turns.push({ speaker, text, pause_ms });
    elapsed += pause_ms + (text.split(" ").length * 400);
    if (rand() < 0.6) speaker = speaker === "A" ? "B" : "A";
  }
  return buildTranscript(turns);
}
