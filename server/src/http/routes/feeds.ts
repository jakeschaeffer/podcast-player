import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import * as S from "../schemas.js";

const Id = Type.Object({ id: Type.String() });
import { PRIORITY } from "../../jobs/queue.js";
import { HttpError } from "../../app/errors.js";
import { addFeed, deleteFeed, getFeedRow, getRefreshRun, listFeeds, requestRefreshRun, resolveFeedInput, toFeedView, updateFeed } from "../../services/feeds.js";
import { jobView } from "./jobs.js";

export function registerFeedsRoutes(instance: FastifyInstance, ctx: AppContext): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();
  app.get("/v1/feeds", { schema: { tags: ["feeds"], summary: "List feeds: podcast feeds and the text feeds attached to them, followed or not unless `followed` filters", querystring: Type.Object({ followed: Type.Optional(Type.Boolean()) }), response: { 200: Type.Array(S.FeedSchema) } } }, async (request) => listFeeds(ctx, { followed: request.query.followed }));
  app.post("/v1/feeds", { schema: { tags: ["feeds"], summary: "Subscribe to a feed; a refresh is queued immediately", body: S.AddFeedBody, response: { 201: S.FeedSchema, 409: S.ErrorSchema } } }, async (request, reply) => {
    return reply.code(201).send(addFeed(ctx, await resolveFeedInput(ctx, request.body)));
  });
  app.get("/v1/feeds/:id", { schema: { tags: ["feeds"], summary: "One feed with its processing settings and last refresh result", params: Id, response: { 200: S.FeedSchema } } }, async (request) => toFeedView(ctx, getFeedRow(ctx, request.params.id)));
  app.patch("/v1/feeds/:id", { schema: { tags: ["feeds"], summary: "Change a feed's title, privacy, auto_process, transcriber, keyterms, backfill, or whether it is followed", params: Id, body: S.UpdateFeedBody, response: { 200: S.FeedSchema } } }, async (request) => updateFeed(ctx, request.params.id, request.body));
  app.delete("/v1/feeds/:id", { schema: { tags: ["feeds"], summary: "Remove a feed and its episodes; refused while snips reference its recordings", params: Id, response: { 204: Type.Null(), 409: S.ErrorSchema } } }, async (request, reply) => {
    await deleteFeed(ctx, request.params.id);
    return reply.code(204).send(null);
  });
  app.post("/v1/feeds/:id/refresh", { schema: { tags: ["feeds"], summary: "Queue an immediate refresh of one feed", params: Id, response: { 202: S.JobSchema } } }, async (request, reply) => {
    getFeedRow(ctx, request.params.id);
    const { id } = ctx.queue.enqueue("refresh_feed", `refresh_feed:${request.params.id}`, { feed_id: request.params.id }, { priority: PRIORITY.play, rerun: true });
    return reply.code(202).send(jobView(ctx, id));
  });
  app.post("/v1/refresh-runs", { schema: { tags: ["feeds"], summary: "Refresh every feed; idempotent per key (cron sends one per local day)", body: Type.Object({ key: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })) }), response: { 202: S.RefreshRunSchema } } }, async (request, reply) => {
    const key = (request.headers["idempotency-key"] as string | undefined) ?? request.body.key ?? `manual-${ctx.now()}`;
    return reply.code(202).send(requestRefreshRun(ctx, key));
  });
  app.get("/v1/refresh-runs/:id", { schema: { tags: ["feeds"], summary: "Status of a refresh run: one job per feed", params: Id, response: { 200: S.RefreshRunSchema } } }, async (request) => getRefreshRun(ctx, request.params.id));

  app.get("/v1/search/shows", { schema: { tags: ["feeds"], summary: "Find public shows to subscribe to (iTunes Search by default, Podcast Index when configured); add one with POST /v1/feeds and its feed_url", querystring: Type.Object({ q: Type.String({ minLength: 2, maxLength: 200 }), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }), response: { 200: Type.Object({ source: Type.String(), results: Type.Array(S.ShowResultSchema) }), 502: S.ErrorSchema } } }, async (request) => {
    let results;
    try {
      results = await ctx.showSearch.search(request.query.q, request.query.limit ?? 10);
    } catch (err) {
      ctx.log("show search failed", { source: ctx.showSearch.name, error: String(err) });
      throw new HttpError(502, `show search is unavailable right now (${ctx.showSearch.name})`, "upstream");
    }
    const subscribed = new Map((ctx.db.prepare("SELECT id, url_hash, followed FROM feed").all() as { id: string; url_hash: string; followed: number }[]).map((f) => [f.url_hash, f]));
    // Directories list some shows twice (a re-uploaded feed, a regional copy); one row per feed URL.
    const seen = new Set<string>();
    const unique = results.filter((r) => {
      const key = normalizeFeedUrl(r.feed_url);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { source: ctx.showSearch.name, results: unique.map((r) => {
      const feed = subscribed.get(ctx.secrets.hash(normalizeFeedUrl(r.feed_url)));
      return { ...r, feed_id: feed?.id ?? null, followed: feed ? feed.followed === 1 : null };
    }) };
  });
}

/** The same normalization addFeed applies before hashing, so a search result matches its subscription. */
function normalizeFeedUrl(u: string): string {
  try { return new URL(u.trim()).toString(); } catch { return u; }
}
