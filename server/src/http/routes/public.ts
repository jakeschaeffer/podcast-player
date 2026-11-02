import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";

import type { FastifyReply } from "fastify";
import { HttpError, notFound } from "../../app/errors.js";
import { sendFile } from "../../services/media.js";
import { publicClip, type PublicClipFile, publicSnip } from "../../services/publicSnips.js";
import { publicEpisode } from "../../services/episodeShares.js";
import { randomBytes } from "node:crypto";
import { renderEpisodeGonePage, renderEpisodePage } from "../public/episodePage.js";
import { type PageImage, renderGonePage, renderPreparingPage, renderPublicPage } from "../public/page.js";
import { cardVersion, episodeShareCard, SHARE_IMAGE, type ShareCard, shareImage, snipShareCard } from "../../services/shareImage.js";

const PUBLIC_FILE_MIME: Record<PublicClipFile, string> = { mp3: "audio/mpeg", mp4: "video/mp4", jpg: "image/jpeg" };

export function registerPublicRoutes(instance: FastifyInstance, ctx: AppContext): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();
  const publicHeaders = (reply: FastifyReply) => {
    reply.header("X-Robots-Tag", "noindex, nofollow");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Content-Security-Policy", "default-src 'none'; media-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:");
    reply.header("Cache-Control", "no-store");
  };
  /** The page's preview image, linked by what it shows, so a changed card is a new URL that link previews fetch again. */
  const pageImage = (path: string, card: ShareCard | null, alt: string): PageImage | null =>
    card ? { url: `${ctx.config.publicBaseUrl}${path}/og.png?v=${cardVersion(card)}`, alt, ...SHARE_IMAGE } : null;
  const sendImage = async (reply: FastifyReply, card: ShareCard | null) => {
    if (!card) throw notFound("page");
    const png = await shareImage(ctx, card);
    reply.header("X-Robots-Tag", "noindex, nofollow");
    // The URL carries the card's version, so a stale copy is never served for a changed page.
    reply.header("Cache-Control", "public, max-age=86400");
    return reply.type("image/png").send(png);
  };
  app.get("/s/:token/og.png", { schema: { tags: ["public"], security: [], summary: "Preview image of a public snip page (PNG, 1200 × 630)", params: Type.Object({ token: Type.String() }) } }, async (request, reply) =>
    sendImage(reply, snipShareCard(ctx, request.params.token)),
  );
  app.get("/e/:token/og.png", { schema: { tags: ["public"], security: [], summary: "Preview image of a public episode page (PNG, 1200 × 630)", params: Type.Object({ token: Type.String() }) } }, async (request, reply) =>
    sendImage(reply, episodeShareCard(ctx, request.params.token)),
  );
  app.get("/s/:token", { schema: { tags: ["public"], security: [], summary: "Public snip page (HTML), or JSON when the token ends in .json", params: Type.Object({ token: Type.String() }) } }, async (request, reply) => {
    publicHeaders(reply);
    const wantsJson = request.params.token.endsWith(".json");
    const token = wantsJson ? request.params.token.slice(0, -5) : request.params.token;
    const view = publicSnip(ctx, token);
    if (wantsJson) {
      if (view.kind === "ready") { const { kind: _k, ...body } = view; return reply.send(body); }
      if (view.kind === "preparing") return reply.code(202).send({ status: "preparing" });
      return reply.code(view.kind === "gone" ? 410 : 404).send({ error: { code: view.kind, message: view.kind === "gone" ? "no longer available" : "not found" } });
    }
    reply.header("Content-Type", "text/html; charset=utf-8");
    if (view.kind === "ready") {
      const image = pageImage(`/s/${token}`, snipShareCard(ctx, token), `${view.title} · ${view.show.title ?? view.episode.title}`);
      return reply.send(renderPublicPage(view, `${ctx.config.publicBaseUrl}/s/${token}`, image));
    }
    if (view.kind === "preparing") return reply.send(renderPreparingPage());
    return reply.code(view.kind === "gone" ? 410 : 404).send(renderGonePage());
  });
  app.get("/e/:token", { schema: { tags: ["public"], security: [], summary: "Public page of every shared snip in one episode (HTML), or JSON when the token ends in .json", params: Type.Object({ token: Type.String() }) } }, async (request, reply) => {
    publicHeaders(reply);
    const wantsJson = request.params.token.endsWith(".json");
    const token = wantsJson ? request.params.token.slice(0, -5) : request.params.token;
    const view = publicEpisode(ctx, token);
    if (wantsJson) {
      if (view.kind === "ready") {
        const base = ctx.config.publicBaseUrl;
        return reply.send({
          episode: view.episode, show: view.show,
          snips: view.snips.map(({ page_path, clip_path, video, ...s }) => ({
            ...s, url: `${base}${page_path}`, clip_url: `${base}${clip_path}`,
            video: video ? { url: `${base}${video.path}`, poster_url: `${base}${video.poster_path}`, width: video.width, height: video.height } : null,
          })),
        });
      }
      return reply.code(view.kind === "gone" ? 410 : 404).send({ error: { code: view.kind, message: view.kind === "gone" ? "no longer available" : "not found" } });
    }
    reply.header("Content-Type", "text/html; charset=utf-8");
    if (view.kind !== "ready") return reply.code(view.kind === "gone" ? 410 : 404).send(renderEpisodeGonePage());
    // The page's player is a small inline script, allowed by a per-response nonce and nothing else.
    const nonce = randomBytes(16).toString("base64");
    reply.header("Content-Security-Policy", `default-src 'none'; media-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; script-src 'nonce-${nonce}'`);
    const image = pageImage(`/e/${token}`, episodeShareCard(ctx, token), `${view.show.title ? `${view.show.title}: ` : ""}${view.episode.title}`);
    return reply.send(renderEpisodePage(view, `${ctx.config.publicBaseUrl}/e/${token}`, nonce, image));
  });
  app.get("/s/:token/:file", { schema: { tags: ["public"], security: [], summary: "Public clip files for the current revision only: /s/{token}/r{rev}.mp3, and for a snip cut from a video r{rev}.mp4 with its poster r{rev}.jpg", params: Type.Object({ token: Type.String(), file: Type.String() }) } }, async (request, reply) => {
    const m = request.params.file.match(/^r(\d+)\.(mp3|mp4|jpg)$/);
    if (!m) throw notFound("file");
    const ext = m[2] as PublicClipFile;
    const result = publicClip(ctx, request.params.token, Number(m[1]), ext);
    if (result === "preparing") { reply.header("Retry-After", "5"); throw new HttpError(404, "clip not ready", "preparing"); }
    if (result === "gone") throw new HttpError(410, "clip no longer available", "gone");
    if (result === "not_found") throw notFound("clip");
    reply.header("X-Robots-Tag", "noindex, nofollow");
    return sendFile(request, reply, result.path, { mime: PUBLIC_FILE_MIME[ext], etag: result.sha256, cacheControl: "public, max-age=31536000, immutable", filename: `snip-${request.params.token}.${ext}` });
  });
}
