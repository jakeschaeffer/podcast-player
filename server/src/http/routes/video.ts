import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { AppContext } from "../../app/context.js";
import { badRequest } from "../../app/errors.js";
import type { Json3 } from "../../core/transcript/captions.js";
import { newId } from "../../lib/ids.js";
import { getEpisode } from "../../services/episodes.js";
import { addYouTubeVideo, requestVideo, setYouTubeVideo, storeCaptions, storeVideoFile, videoDone, videoFailed, wantedVideos } from "../../services/video.js";
import * as S from "../schemas.js";

const Id = Type.Object({ id: Type.String() });
/** Captions for a day-long video are a few megabytes; the default limit is one. */
const CAPTIONS_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Video (docs/video-plan.md): the owner asks for an episode's video; the home fetcher (fetcher/README.md) polls for
 * YouTube videos wanted, uploads each video file and its captions, then says it is done.
 */
export function registerVideoRoutes(instance: FastifyInstance, ctx: AppContext): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();
  // A video upload is streamed to disk as it arrives, never held in memory; the parser hands the route the raw stream.
  for (const type of ["video/mp4", "application/octet-stream"]) {
    app.addContentTypeParser(type, (_request, payload, done) => done(null, payload));
  }

  app.patch("/v1/episodes/:id", { schema: { tags: ["video"], summary: "Name the episode's YouTube video (the notes linked one that was taken down, or none): the next request for its video fetches this one. null forgets the link", params: Id, body: Type.Object({ youtube_id: Type.Union([Type.String({ minLength: 11, maxLength: 11 }), Type.Null()]) }), response: { 200: S.EpisodeDetailSchema } } }, async (request) => {
    setYouTubeVideo(ctx, request.params.id, request.body.youtube_id);
    return getEpisode(ctx, request.params.id, request.device.id);
  });
  app.post("/v1/episodes/:id/video", { schema: { tags: ["video"], summary: "Ask for the episode's video: a feed's own file is fetched by the server; a YouTube video by the home fetcher. 202 with the episode", params: Id, response: { 202: S.EpisodeDetailSchema } } }, async (request, reply) => {
    requestVideo(ctx, request.params.id);
    return reply.code(202).send(getEpisode(ctx, request.params.id, request.device.id));
  });

  app.post("/v1/youtube/episodes", { schema: { tags: ["video"], summary: "A pasted YouTube video link becomes an episode of its channel's show (created unfollowed if the library lacks it) and its video is asked for; a video an episode already names is that episode. 201 with the episode", body: Type.Object({ url: Type.String({ minLength: 1, maxLength: 2048 }) }), response: { 201: S.EpisodeDetailSchema, 400: S.ErrorSchema } } }, async (request, reply) => {
    return reply.code(201).send(await addYouTubeVideo(ctx, request.body.url, request.device.id));
  });

  app.get("/v1/video/wanted", { schema: { tags: ["video"], summary: "For the home fetcher: YouTube videos the owner asked for and nobody has delivered, oldest first", querystring: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }), response: { 200: Type.Object({ items: Type.Array(S.WantedVideoSchema) }) } } }, async (request) => {
    return { items: wantedVideos(ctx, request.query.limit ?? 20) };
  });

  app.put("/v1/episodes/:id/video/file", { schema: { tags: ["video"], summary: "The episode's video file (MP4, H.264 + AAC), streamed as the request body with Content-Type video/mp4. Becomes the episode's recording; its audio is pulled out beside it", params: Id, response: { 200: S.EpisodeDetailSchema } } }, async (request, reply) => {
    const body = request.body as NodeJS.ReadableStream | undefined;
    if (!body || typeof (body as { pipe?: unknown }).pipe !== "function") throw badRequest("send the video as the request body with Content-Type video/mp4");
    await mkdir(ctx.paths.tmp, { recursive: true });
    const tmp = join(ctx.paths.tmp, `${newId()}.upload`);
    try {
      await pipeline(body, createWriteStream(tmp));
      await storeVideoFile(ctx, request.params.id, tmp);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    return reply.send(getEpisode(ctx, request.params.id, request.device.id));
  });

  app.put(
    "/v1/episodes/:id/video/captions",
    {
      bodyLimit: CAPTIONS_MAX_BYTES,
      schema: { tags: ["video"], summary: "The video's captions in YouTube's json3 form, after its file: they become its transcript", params: Id, querystring: Type.Object({ kind: Type.Union([Type.Literal("auto"), Type.Literal("manual")]), lang: Type.Optional(Type.String({ maxLength: 16 })) }), body: Type.Object({ events: Type.Optional(Type.Array(Type.Unknown())) }, { additionalProperties: true }), response: { 200: Type.Object({ transcript_id: Type.String(), word_count: Type.Integer(), current: Type.Boolean() }) } },
    },
    async (request) => storeCaptions(ctx, request.params.id, request.body as Json3, { kind: request.query.kind, language: request.query.lang ?? null }),
  );

  app.post("/v1/episodes/:id/video/done", { schema: { tags: ["video"], summary: "The fetcher has sent the video and whatever captions it found; a video without a transcript is transcribed", params: Id, response: { 200: S.EpisodeDetailSchema } } }, async (request) => {
    videoDone(ctx, request.params.id);
    return getEpisode(ctx, request.params.id, request.device.id);
  });

  app.post("/v1/episodes/:id/video/failed", { schema: { tags: ["video"], summary: "The fetcher could not get the video; the message is shown in the apps until the owner asks again", params: Id, body: Type.Object({ message: Type.String({ maxLength: 500 }) }), response: { 200: S.EpisodeDetailSchema } } }, async (request) => {
    videoFailed(ctx, request.params.id, request.body.message);
    return getEpisode(ctx, request.params.id, request.device.id);
  });
}
