import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { readwiseSummary, retryReadwiseFailures } from "../../services/readwiseSync.js";
import * as S from "../schemas.js";

export function registerReadwiseRoutes(instance: FastifyInstance, ctx: AppContext): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();
  app.get("/v1/readwise", { schema: { tags: ["snips"], summary: "How the snips of the last `days` (30) stand with the owner's Readwise, and every failed send", querystring: Type.Object({ days: Type.Optional(Type.Integer({ minimum: 1, maximum: 365 })) }), response: { 200: S.ReadwiseSummarySchema } } }, async (request) => {
    return readwiseSummary(ctx, request.query.days);
  });
  app.post("/v1/readwise/retries", { schema: { tags: ["snips"], summary: "Send every failed snip to Readwise again now (idempotent); returns the summary. 409 when Readwise is not set up", response: { 200: S.ReadwiseSummarySchema, 409: S.ErrorSchema } } }, async () => {
    retryReadwiseFailures(ctx);
    return readwiseSummary(ctx);
  });
}
