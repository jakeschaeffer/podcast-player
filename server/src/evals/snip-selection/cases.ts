/** Shared shapes for snip-selection eval cases. */

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
  source: {
    readwise_highlight_id: number;
    snipd_url: string | null;
    readwise_offset_s: number | null;
    anchor_position: number | "after";
    episode_id: string;
    asset_id: string;
    alignment: { coverage: number; length_ratio: number; snip_tokens: number };
  };
  tags: string[];
};

export function wordsBucket(n: number): string {
  if (n < 200) return "words:<200";
  if (n < 400) return "words:200-400";
  if (n < 700) return "words:400-700";
  return "words:700+";
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}
