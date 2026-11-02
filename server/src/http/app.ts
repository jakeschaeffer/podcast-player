import swagger from "@fastify/swagger";
import { type TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppContext } from "../app/context.js";
import { HttpError } from "../app/errors.js";
import { deviceForRequest, registerAuthHook } from "./auth.js";
import { registerDevicesRoutes } from "./routes/devices.js";
import { registerEpisodesRoutes } from "./routes/episodes.js";
import { registerFeedsRoutes } from "./routes/feeds.js";
import { registerJobsRoutes } from "./routes/jobs.js";
import { registerLinksRoutes } from "./routes/links.js";
import { registerPromptsRoutes } from "./routes/prompts.js";
import { registerMediaRoutes } from "./routes/media.js";
import { registerPlaybackRoutes } from "./routes/playback.js";
import { registerPublicRoutes } from "./routes/public.js";
import { registerSnipsRoutes } from "./routes/snips.js";
import { registerVideoRoutes } from "./routes/video.js";

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: true, bodyLimit: 1024 * 1024 }).withTypeProvider<TypeBoxTypeProvider>();

  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Podcast player API",
        version: "0.1.0",
        description:
          "Owner API for a personal podcast player with one-tap snips. All /v1 routes except POST /v1/devices and GET /v1/health need `Authorization: Bearer <device token>` (or the web cookie). Times are integer milliseconds relative to one audio asset. See docs/core in the repository for the data model and function contracts.",
      },
      components: { securitySchemes: { device: { type: "http", scheme: "bearer" } } },
      security: [{ device: [] }],
      tags: [
        { name: "devices", description: "Login and device tokens" },
        { name: "feeds", description: "Subscriptions, public and private" },
        { name: "episodes", description: "Episodes, recordings, transcripts, summaries" },
        { name: "playback", description: "Resume state per device" },
        { name: "snips", description: "Create, edit, share, revoke" },
        { name: "jobs", description: "Background work and processing state" },
        { name: "prompts", description: "Prompt versions, which one is active, and eval runs" },
        { name: "public", description: "Recipient-facing pages; no authentication" },
        { name: "media", description: "Signed audio URLs" },
      ],
    },
  });

  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: { code: err.code, message: err.message, ...err.extra } });
    const fe = err as { validation?: unknown; statusCode?: number; message: string };
    if (fe.validation) return reply.code(400).send({ error: { code: "validation", message: fe.message } });
    if (fe.statusCode && fe.statusCode < 500) return reply.code(fe.statusCode).send({ error: { code: "request", message: fe.message } });
    ctx.log("unhandled error", { error: err instanceof Error ? err.stack ?? err.message : String(err) });
    return reply.code(500).send({ error: { code: "internal", message: "internal error" } });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: { code: "not_found", message: "route not found" } }));

  registerAuthHook(app, ctx);

  app.get(
    "/v1/health",
    { schema: { tags: ["jobs"], security: [], summary: "Liveness without authentication; queue counts only with a device token", response: { 200: Type.Object({ ok: Type.Boolean(), jobs: Type.Optional(Type.Record(Type.String(), Type.Integer())) }) } } },
    async (request) => (deviceForRequest(ctx, request) ? { ok: true, jobs: ctx.queue.counts() } : { ok: true }),
  );
  app.get("/v1/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  // Owner API, then signed media, then the recipient-facing pages. Each file owns one area of the contract.
  registerDevicesRoutes(app, ctx);
  registerFeedsRoutes(app, ctx);
  registerEpisodesRoutes(app, ctx);
  registerVideoRoutes(app, ctx);
  registerLinksRoutes(app, ctx);
  registerPlaybackRoutes(app, ctx);
  registerSnipsRoutes(app, ctx);
  registerJobsRoutes(app, ctx);
  registerPromptsRoutes(app, ctx);
  registerMediaRoutes(app, ctx);
  registerPublicRoutes(app, ctx);

  await app.ready();
  return app;
}
