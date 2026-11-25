import { api, unwrap } from "./client";
import type { EpisodeDetail } from "./types";

/** Ask for an episode's transcript: every step it still lacks is queued (audio, transcription, publisher text, summary). Billed. */
export async function processEpisode(episodeId: string): Promise<EpisodeDetail> {
  return unwrap(api.POST("/v1/episodes/{id}/process", { params: { path: { id: episodeId } } }));
}
