/** Shared shapes for snip-selection eval cases. */
import type { Sentence } from "../../core/snip/sentencize.js";

/** A case from the owner's Snipd library: the snip's words aligned to our transcript, the tap simulated. */
export type ReadwiseSource = {
  readwise_highlight_id: number;
  snipd_url: string | null;
  readwise_offset_s: number | null;
  anchor_position: number | "after";
  episode_id: string;
  asset_id: string;
  alignment: { coverage: number; length_ratio: number; snip_tokens: number };
};

/** A case from a snip made in the app: the real tap, what the server chose for it, and whether the owner moved it. */
export type AppSource = {
  kind: "app";
  snip_id: string;
  episode_id: string;
  asset_id: string;
  /** The owner moved a boundary: the label is exact. Left alone, the label is the span as chosen, which nothing says was looked at. */
  edited: boolean;
  chosen: { method: string; selector: string | null; start_ms: number; end_ms: number };
};

export function isAppCase(c: SnipCase): c is SnipCase & { source: AppSource } {
  return "kind" in c.source && c.source.kind === "app";
}

export type SnipCase = {
  id: string;
  transcript_fixture: string;
  anchor_ms: number;
  heard_from_ms: number;
  label: {
    idea: string;
    ideal_start_word: number;
    ideal_end_word: number;
    ideal_start_ms: number;
    ideal_end_ms: number;
    acceptable_start_ms: [number, number];
    acceptable_end_ms: [number, number];
  };
  source: ReadwiseSource | AppSource;
  tags: string[];
};

/**
 * How far a chosen boundary may sit from the labelled one and still need no edit: one sentence either side of the
 * sentence the labelled start falls in; for the end, from just before the previous sentence's end to just after its own.
 */
export function acceptableRanges(sentences: Sentence[], startIdx: number, lastIdx: number): Pick<SnipCase["label"], "acceptable_start_ms" | "acceptable_end_ms"> {
  const startS = sentences[startIdx]!;
  const prev = sentences[startIdx - 1];
  const next = sentences[startIdx + 1];
  const last = sentences[lastIdx]!;
  const beforeLast = sentences[lastIdx - 1];
  return {
    acceptable_start_ms: [prev ? prev.start_ms : startS.start_ms, next ? next.start_ms : startS.end_ms],
    acceptable_end_ms: [beforeLast ? beforeLast.end_ms - 500 : last.start_ms, last.end_ms + 500],
  };
}

export function wordsBucket(n: number): string {
  if (n < 200) return "words:<200";
  if (n < 400) return "words:200-400";
  if (n < 700) return "words:400-700";
  return "words:700+";
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}
