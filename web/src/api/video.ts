import { api, unwrap } from "./client";
import type { EpisodeDetail, Feed } from "./types";

/** Ask for an episode's video (docs/video-plan.md): a feed's own file the server fetches; a YouTube video the home fetcher brings. */
export async function requestVideo(episodeId: string): Promise<EpisodeDetail> {
  return unwrap(api.POST("/v1/episodes/{id}/video", { params: { path: { id: episodeId } } }));
}

/** Ask for a channel's next fifteen older videos: the home fetcher lists them, and nothing is downloaded. */
export async function askForMoreVideos(feedId: string): Promise<Feed> {
  return unwrap(api.POST("/v1/feeds/{id}/more-videos", { params: { path: { id: feedId } } }));
}
