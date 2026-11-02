import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { addPastedLink } from "../../services/links.js";
import * as S from "../schemas.js";

/** Pasted links (services/links.ts): one-off episodes from links to media files, in the "Pasted links" show. */
export function registerLinksRoutes(instance: FastifyInstance, ctx: AppContext): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();
  app.post(
    "/v1/links/episodes",
    {
      schema: {
        tags: ["video"],
        summary:
          "A pasted link to a video or audio file becomes a one-off episode of the Pasted links show (kind 'links': made on first use, followed, never refreshed); the server downloads the file and transcribes it, which bills. The same link twice is the same episode. A YouTube video link is handled as POST /v1/youtube/episodes; a link to a web page (an x.com post, say) is refused, since its file would need the home fetcher. 201 with the episode",
        body: Type.Object({
          url: Type.String({ minLength: 1, maxLength: 2048 }),
          title: Type.Optional(Type.String({ minLength: 1, maxLength: 300, description: "The episode's title; else the file's name when it reads like one, else where the file came from" })),
        }),
        response: { 201: S.EpisodeDetailSchema, 400: S.ErrorSchema },
      },
    },
    async (request, reply) => reply.code(201).send(await addPastedLink(ctx, request.body, request.device.id)),
  );
}
