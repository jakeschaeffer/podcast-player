import { api, unwrap } from "../api/client";
import type { EpisodeListItem } from "../api/types";
import { invalidate } from "../lib/useQuery";

/**
 * Up next, kept on the server in the owner's order (on any device): ones heard partway and not yet placed first, most
 * recently listened first, then the ones placed or added. Each change returns the whole new list.
 */
export const QUEUE_KEY = "queue";

export async function fetchQueue(): Promise<EpisodeListItem[]> {
  return (await unwrap(api.GET("/v1/queue", { params: { query: { limit: 100 } }, cache: "no-store" }))).items;
}

export async function reorderQueue(episodeIds: string[]): Promise<EpisodeListItem[]> {
  return (await unwrap(api.PUT("/v1/queue", { body: { episode_ids: episodeIds } }))).items;
}

/** Add an episode to the end of Up next; its recording is fetched now, so it can start the moment one ends. */
export async function addToQueue(episodeId: string): Promise<EpisodeListItem[]> {
  const items = (await unwrap(api.POST("/v1/queue/{id}", { params: { path: { id: episodeId } } }))).items;
  invalidate(QUEUE_KEY);
  return items;
}

/** Take an episode out of Up next without marking it played; playing it again brings it back. */
export async function removeFromQueue(episodeId: string): Promise<EpisodeListItem[]> {
  return (await unwrap(api.DELETE("/v1/queue/{id}", { params: { path: { id: episodeId } } }))).items;
}

/** The episode to play when `finishedId` ends: the first up next that isn't it. */
export async function nextAfter(finishedId: string): Promise<EpisodeListItem | null> {
  return (await fetchQueue()).find((e) => e.id !== finishedId) ?? null;
}
