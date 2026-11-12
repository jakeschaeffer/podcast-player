import { api, unwrap } from "./client";
import type { Transcript } from "./types";

/**
 * openapi-fetch's response helper widens the word tuples [start, end, text] to (number | string)[];
 * the contract (and the server) guarantee the tuple, so narrow back to the generated schema type.
 */
export async function fetchTranscript(id: string): Promise<Transcript> {
  return (await unwrap(api.GET("/v1/transcripts/{id}", { params: { path: { id } } }))) as Transcript;
}

export type Speaker = { label: string; role: "host" | "guest" | "other"; name: string | null };

/** Who the transcript's voices are, or null until the server has worked it out (asking queues that). */
export async function fetchSpeakers(id: string): Promise<Speaker[] | null> {
  return (await unwrap(api.GET("/v1/transcripts/{id}/speakers", { params: { path: { id } } }))).speakers;
}

/**
 * What a label is shown as, or null for no heading. Speech recognition's labels ("S1") show as the name when known,
 * else "Host" or "Guest", else "Speaker 2"; publisher text's labels are names already and show as written, except
 * "Quote" (a passage the text quotes), which has none. The server's speakerDisplayName is the reference;
 * contracts/golden/speakers/speaker_names_v1.json holds the cases.
 */
export function speakerName(label: string | null, speakers: Speaker[] | null): string | null {
  if (!label || label === "Quote") return null;
  const who = speakers?.find((s) => s.label === label);
  if (who?.name) return who.name;
  if (!/^S\d+$/.test(label)) return label;
  if (who?.role === "host") return "Host";
  if (who?.role === "guest") return "Guest";
  return `Speaker ${label.slice(1)}`;
}
