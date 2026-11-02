/** Shapes for segment → title eval cases. */
import type { TitleOrigin } from "./origin.js";

export type TitleCase = {
  id: string;
  /** Where the reference title came from: the owner's Snipd library via Readwise, or a title edited in this app. */
  source: "readwise" | "app";
  show: string | null;
  episode: string;
  /** The segment as spoken turns; the only input a title model gets besides show and episode. */
  excerpt: { speaker: string | null; text: string }[];
  excerpt_words: number;
  /** The title to match: written (all or in part) by the owner unless origin says otherwise. */
  reference_title: string;
  origin: TitleOrigin | "app-edit";
  origin_confidence: "high" | "medium" | "exact";
  origin_reasons: string[];
  /** For appended titles: the headline Snipd wrote and the note the owner added after it. */
  generated_part?: string;
  owner_part?: string;
  /** Another model's title for the same segment: Snipd's headline, or this app's model before the owner rewrote it. */
  other_model_title?: string | null;
  meta: { readwise_highlight_id?: number; snipd_url?: string | null; highlighted_at?: string | null; snip_id?: string; revision_id?: string; edited_at?: number };
  tags: string[];
};
