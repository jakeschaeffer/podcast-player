// Convenience aliases over the generated contract. Nothing here is hand-written shape:
// every type is looked up from src/api/schema.d.ts, which `pnpm gen:api` regenerates.
import type { paths } from "./schema";

type Json<T> = T extends { content: { "application/json": infer J } } ? J : never;
type Ok<P extends keyof paths, M extends keyof paths[P]> = paths[P][M] extends { responses: { 200: infer R } } ? Json<R> : never;

export type Feed = Ok<"/v1/feeds", "get">[number];
export type ShowSearchPage = Ok<"/v1/search/shows", "get">;
export type ShowResult = ShowSearchPage["results"][number];
export type EpisodePage = Ok<"/v1/episodes", "get">;
export type EpisodeListItem = EpisodePage["items"][number];
export type EpisodeDetail = Ok<"/v1/episodes/{id}", "get">;
export type EpisodeShare = Ok<"/v1/episodes/{id}/share", "post">;
export type Chapter = NonNullable<EpisodeDetail["chapters"]>["items"][number];
export type Transcript = Ok<"/v1/transcripts/{id}", "get">;
export type Segment = Transcript["segments"][number];
export type Snip = Ok<"/v1/snips/{id}", "get">;
export type SnipRevision = NonNullable<Snip["revision"]>;
export type SnipPage = Ok<"/v1/snips", "get">;
export type PlaybackBody = paths["/v1/playback/{asset_id}"]["put"]["requestBody"]["content"]["application/json"];
export type CreateSnipBody = paths["/v1/snips"]["post"]["requestBody"]["content"]["application/json"];
export type EditSnipBody = paths["/v1/snips/{id}"]["patch"]["requestBody"]["content"]["application/json"];
export type Processing = EpisodeListItem["processing"];
export type Prompt = Ok<"/v1/prompts", "get">[number];
export type PromptVersion = Ok<"/v1/prompts/{name}/versions/{version}", "get">;
export type EvalRun = PromptVersion["runs"][number];
export type EvalRunDetail = Ok<"/v1/evals/{eval}/runs/{run}", "get">;
export type Score = NonNullable<EvalRun["score"]>;
