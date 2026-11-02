import { api, unwrap } from "./client";
import type { EpisodeDetail } from "./types";

/** Ask for an episode's video (docs/video-plan.md): a feed's own file the server fetches; a YouTube video the home fetcher brings. */
export async function requestVideo(episodeId: string): Promise<EpisodeDetail> {
  return unwrap(api.POST("/v1/episodes/{id}/video", { params: { path: { id: episodeId } } }));
}
