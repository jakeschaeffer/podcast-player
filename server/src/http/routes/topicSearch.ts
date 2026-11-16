import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { getTopicSearch, listTopicSearches, startTopicSearch, topicSearchEnabled } from "../../services/topicSearch.js";
import * as S from "../schemas.js";

export function registerTopicSearchRoutes(instance: FastifyInstance, ctx: AppContext): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();
  app.get("/v1/topic-searches", {
    schema: {
      tags: ["feeds"],
      summary: "Whether topic search is on (the server has EXA_API_KEY), and the newest searches",
      querystring: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
      response: { 200: Type.Object({ enabled: Type.Boolean(), items: Type.Array(S.TopicSearchSchema) }) },
    },
  }, async (request) => ({ enabled: topicSearchEnabled(ctx), items: listTopicSearches(ctx, request.query.limit ?? 20) }));
  app.post("/v1/topic-searches", {
    schema: {
      tags: ["feeds"],
      summary: "Find episodes about a topic, in any show, through Exa's podcast search. Bills one Exa run (201), unless the same query ran within a day or client_request_id was seen (200, that search). Poll GET /v1/topic-searches/{id}. 409 when topic search is off",
      body: S.StartTopicSearchBody,
      response: { 200: S.TopicSearchSchema, 201: S.TopicSearchSchema, 409: S.ErrorSchema, 502: S.ErrorSchema },
    },
  }, async (request, reply) => {
    const { search, created } = await startTopicSearch(ctx, request.body);
    return reply.code(created ? 201 : 200).send(search);
  });
  app.get("/v1/topic-searches/:id", {
    schema: {
      tags: ["feeds"],
      summary: "One topic search; while running, asks Exa how it stands (free). Results are matched to our episodes and shows on every read",
      params: Type.Object({ id: Type.String() }),
      response: { 200: S.TopicSearchSchema },
    },
  }, async (request) => getTopicSearch(ctx, request.params.id));
}
