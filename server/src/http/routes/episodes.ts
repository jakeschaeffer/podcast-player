import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import * as S from "../schemas.js";

const Id = Type.Object({ id: Type.String() });
import { addToQueue, ensureAudioForPlay, getEpisode, listEpisodes, listQueue, processEpisode, removeFromQueue, setQueueOrder } from "../../services/episodes.js";
import { getEpisodeShare, revokeEpisodeShare, shareEpisode } from "../../services/episodeShares.js";
import { getTranscriptRow, transcriptApi } from "../../services/transcripts.js";
import { queueSpeakers, speakersFor } from "../../services/speakers.js";
import { PRIORITY } from "../../jobs/queue.js";

export function registerEpisodesRoutes(instance: FastifyInstance, ctx: AppContext): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();
  app.get("/v1/episodes", { schema: { tags: ["episodes"], summary: "Episodes newest first, optionally for one feed; page with the returned `next` cursor as `after`", querystring: Type.Composite([S.PageQuery, Type.Object({ feed_id: Type.Optional(Type.String()) })]), response: { 200: Type.Object({ items: Type.Array(S.EpisodeListItemSchema), next: S.Nullable(Type.String()) }) } } }, async (request) => {
    return listEpisodes(ctx, request.query);
  });
  const Queue = Type.Object({ items: Type.Array(S.EpisodeListItemSchema) });
  app.get("/v1/queue", { schema: { tags: ["episodes"], summary: "Up next: episodes started and not finished and episodes added, in the owner's order; ones not yet placed (heard partway, most recently listened first, any device) come first", querystring: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }), response: { 200: Queue } } }, async (request) => {
    return listQueue(ctx, request.query);
  });
  app.put("/v1/queue", { schema: { tags: ["episodes"], summary: "Put Up next in this order, first to last (idempotent); episodes left out keep their places. Returns the new Up next", body: Type.Object({ episode_ids: Type.Array(Type.String(), { maxItems: 200 }) }), response: { 200: Queue } } }, async (request) => {
    return setQueueOrder(ctx, request.body.episode_ids);
  });
  app.post("/v1/queue/:id", { schema: { tags: ["episodes"], summary: "Add an episode to the end of Up next, even one finished or removed, and fetch, transcribe and summarize it now at owner priority (ignores the monthly budget). Returns the new Up next", params: Id, response: { 200: Queue } } }, async (request) => {
    return addToQueue(ctx, request.params.id);
  });
  app.delete("/v1/queue/:id", { schema: { tags: ["episodes"], summary: "Take an episode out of Up next without marking it played (idempotent); playing it again or adding it brings it back. Returns the new Up next", params: Id, response: { 200: Queue } } }, async (request) => {
    return removeFromQueue(ctx, request.params.id);
  });
  app.get("/v1/episodes/:id", { schema: { tags: ["episodes"], summary: "Episode with signed audio URL, resume state, transcript id, summary, and processing state", params: Id, response: { 200: S.EpisodeDetailSchema } } }, async (request) => {
    return getEpisode(ctx, request.params.id, request.device.id);
  });
  app.get("/v1/episodes/:id/share", { schema: { tags: ["episodes"], summary: "The episode's public snips page, or null when it has never been shared", params: Id, response: { 200: Type.Union([S.EpisodeShareSchema, Type.Null()]) } } }, async (request) => {
    return getEpisodeShare(ctx, request.params.id);
  });
  app.post("/v1/episodes/:id/share", { schema: { tags: ["episodes"], summary: "Share every snip of the episode on one public page; idempotent, and reactivates a revoked link", params: Id, response: { 200: S.EpisodeShareSchema } } }, async (request) => {
    return shareEpisode(ctx, request.params.id);
  });
  app.post("/v1/episodes/:id/share/revoke", { schema: { tags: ["episodes"], summary: "Withdraw the episode's public snips page; the snips' own links are untouched", params: Id, response: { 200: S.EpisodeShareSchema } } }, async (request) => {
    return revokeEpisodeShare(ctx, request.params.id);
  });
  app.post("/v1/episodes/:id/audio", { schema: { tags: ["episodes"], summary: "Fetch the recording now (play priority) so playback can start", params: Id, response: { 202: S.EpisodeDetailSchema } } }, async (request, reply) => {
    ensureAudioForPlay(ctx, request.params.id);
    return reply.code(202).send(getEpisode(ctx, request.params.id, request.device.id));
  });
  app.post("/v1/episodes/:id/process", { schema: { tags: ["episodes"], summary: "Run the whole pipeline for this episode now (audio, transcript, publisher-text alignment, summary), whatever the feed's auto_process setting", params: Id, response: { 202: S.EpisodeDetailSchema } } }, async (request, reply) => {
    return reply.code(202).send(processEpisode(ctx, request.params.id, request.device.id));
  });
  app.get("/v1/transcripts/:id", { schema: { tags: ["episodes"], summary: "Immutable word-timed transcript", params: Id, response: { 200: S.TranscriptSchema } } }, async (request, reply) => {
    reply.header("Cache-Control", "private, max-age=31536000, immutable");
    return transcriptApi(ctx, request.params.id);
  });
  app.get("/v1/transcripts/:id/speakers", { schema: { tags: ["episodes"], summary: "Who the transcript's voices are: host, guest or other, named when the publisher says who", params: Id, response: { 200: S.SpeakersSchema } } }, async (request, reply) => {
    getTranscriptRow(ctx, request.params.id); // 404 for an unknown transcript
    const speakers = speakersFor(ctx, request.params.id);
    if (!speakers) queueSpeakers(ctx, request.params.id, PRIORITY.play);
    reply.header("Cache-Control", speakers ? "private, max-age=86400" : "no-store");
    return { speakers };
  });
}
