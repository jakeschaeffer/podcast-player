/**
 * A snip as a Readwise highlight. Laid out like the Snipd highlights already in the owner's Readwise, so old and new
 * read alike in the daily review: the title, the summary's lines, then "Transcript:" and the words, by speaker when
 * a name is known. The owner's own note goes in the highlight's note; the public page, which plays the clip, is its
 * link. Pure: the sync job (services/readwiseSync.ts) gathers the input.
 */
import type { ReadwiseHighlight, ReadwiseHighlightPatch } from "../../adapters/readwise.js";

export const READWISE_SOURCE_TYPE = "snip_podcasts";

/**
 * The layout's version. Changing what `highlightText` makes calls for a new one: the sync sends every highlight again
 * when the version it last sent differs (services/readwiseSync.ts). "2": publisher text's names, and its unnamed paragraphs.
 */
export const READWISE_FORMAT = "2";

/** Readwise's field limits (characters). */
export const READWISE_LIMITS = { text: 8191, title: 511, author: 1024, note: 8191, url: 2047 } as const;

export type ReadwiseSnip = {
  title: string;
  /** The summary, one point a line; null when there is none (no model, or it failed). */
  summary: string | null;
  /** The words of the span; null without a transcript. */
  excerpt: string | null;
  /** The words in paragraphs, each under the name to show or none. Null shows `excerpt` as one block. */
  turns: { name: string | null; text: string }[] | null;
  note: string | null;
  episode_title: string;
  show_title: string | null;
  image_url: string | null;
  /** The episode's own page, if it has one. */
  source_url: string | null;
  start_ms: number;
  captured_at: number;
  /** The snip's public page: stable across edits, and where the clip plays. */
  share_url: string;
};

export function readwiseHighlight(s: ReadwiseSnip): ReadwiseHighlight {
  const note = s.note?.trim();
  return {
    text: highlightText(s),
    title: clip(s.episode_title.trim() || "Untitled episode", READWISE_LIMITS.title),
    ...(s.show_title?.trim() ? { author: clip(s.show_title.trim(), READWISE_LIMITS.author) } : {}),
    ...(s.image_url && s.image_url.length <= READWISE_LIMITS.url && /^https?:\/\//.test(s.image_url) ? { image_url: s.image_url } : {}),
    ...(s.source_url && s.source_url.length <= READWISE_LIMITS.url && /^https?:\/\//.test(s.source_url) ? { source_url: s.source_url } : {}),
    source_type: READWISE_SOURCE_TYPE,
    category: "podcasts",
    ...(note ? { note: clip(note, READWISE_LIMITS.note) } : {}),
    location: Math.floor(s.start_ms / 1000),
    location_type: "time_offset",
    highlighted_at: new Date(s.captured_at).toISOString(),
    highlight_url: s.share_url,
  };
}

/** The fields of an existing highlight a later sync may change. An empty note clears one the owner removed. */
export function readwisePatch(h: ReadwiseHighlight): ReadwiseHighlightPatch {
  return { text: h.text, note: h.note ?? "", location: h.location, url: h.highlight_url };
}

/** Title and summary always fit; the transcript is cut at a word, with an ellipsis, to keep within Readwise's limit. */
export function highlightText(s: ReadwiseSnip): string {
  const head = [s.title.trim(), ...(s.summary ?? "").split("\n").map((l) => l.trim()).filter(Boolean)].join("\n");
  const blocks = s.turns && s.turns.length > 0
    ? s.turns.map((t) => (t.name ? `${t.name}\n${t.text.trim()}` : t.text.trim()))
    : s.excerpt?.trim() ? [s.excerpt.trim()] : [];
  if (blocks.length === 0) return clip(head || "Snip", READWISE_LIMITS.text);
  return clip(`${head}\n\nTranscript:\n${blocks.join("\n\n")}`, READWISE_LIMITS.text);
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const atWord = cut.replace(/\s+\S*$/, "");
  return `${atWord.length > max * 0.8 ? atWord : cut}…`;
}
