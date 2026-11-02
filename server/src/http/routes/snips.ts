import { createHash } from "node:crypto";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import * as S from "../schemas.js";

const Id = Type.Object({ id: Type.String() });
import { createSnip, deleteSnip, editSnip, getSnip, listSnips, restoreSnip, revokeSnip, type SnipView } from "../../services/snips.js";
import { listTitleEdits } from "../../services/titleEdits.js";

/**
 * Changes whenever anything the owner can see changes (a title or note edit included), but not when only the clip
 * URL's signature is re-minted, which happens on every read.
 */
export function snipEtag(snip: SnipView): string {
  const stable = { ...snip, revision: snip.revision ? { ...snip.revision, clip_url: snip.revision.clip_url !== null } : null };
  return `"${createHash("sha256").update(JSON.stringify(stable)).digest("base64url").slice(0, 22)}"`;
}

export function registerSnipsRoutes(instance: FastifyInstance, ctx: AppContext): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();
  app.post("/v1/snips", { schema: { tags: ["snips"], summary: "Capture a tap; returns the snip with its public URL immediately", body: S.CreateSnipBody, response: { 200: S.SnipSchema, 201: S.SnipSchema } } }, async (request, reply) => {
    const { snip, created } = createSnip(ctx, request.body, request.device.id);
    return reply.code(created ? 201 : 200).send(snip);
  });
  app.get("/v1/snips", { schema: { tags: ["snips"], summary: "The owner's snips newest first; `q` searches title, summary, excerpt, and note", querystring: S.SnipListQuery, response: { 200: Type.Object({ items: Type.Array(S.SnipSchema), next: S.Nullable(Type.String()) }) } } }, async (request) => {
    return listSnips(ctx, request.device.id, request.query);
  });
  app.get("/v1/snips/:id", { schema: { tags: ["snips"], summary: "Snip with its current revision; poll with If-None-Match while preparing", params: Id, response: { 200: S.SnipSchema, 304: Type.Null() } } }, async (request, reply) => {
    const snip = getSnip(ctx, request.params.id, request.device.id);
    const tag = snipEtag(snip);
    reply.header("ETag", tag);
    if (request.headers["if-none-match"] === tag) return reply.code(304).send(null);
    return snip;
  });
  app.patch("/v1/snips/:id", { schema: { tags: ["snips"], summary: "Edit boundaries (new revision), note, or title", params: Id, body: S.EditSnipBody, response: { 200: S.SnipSchema, 409: S.ErrorSchema } } }, async (request) => {
    return editSnip(ctx, request.params.id, request.body, request.device.id);
  });
  app.post("/v1/snips/:id/revoke", { schema: { tags: ["snips"], summary: "Withdraw the public link; sticky until restored", params: Id, response: { 200: S.SnipSchema } } }, async (request) => revokeSnip(ctx, request.params.id, request.device.id));
  app.post("/v1/snips/:id/restore", { schema: { tags: ["snips"], summary: "Reactivate a revoked public link", params: Id, response: { 200: S.SnipSchema } } }, async (request) => restoreSnip(ctx, request.params.id, request.device.id));
  app.delete("/v1/snips/:id", { schema: { tags: ["snips"], summary: "Delete a snip; its public link stops serving and its clips are removed later", params: Id, response: { 204: Type.Null() } } }, async (request, reply) => {
    deleteSnip(ctx, request.params.id);
    return reply.code(204).send(null);
  });
  app.get("/v1/export/title-edits", { schema: { tags: ["snips"], summary: "Every title the owner wrote, with its span, excerpt, and the model's title: ground truth for title evals", response: { 200: Type.Array(S.TitleEditSchema) } } }, async () => listTitleEdits(ctx));
  app.get("/v1/export/snips.json", { schema: { tags: ["snips"], summary: "Every snip with its current revision and provenance", response: { 200: Type.Array(S.SnipSchema) } } }, async (request) => {
    return listSnips(ctx, request.device.id, { limit: 200 }).items;
  });
  app.get("/v1/export/snips.md", { schema: { tags: ["snips"], summary: "Markdown export, one section per snip" } }, async (request, reply) => {
    const items = listSnips(ctx, request.device.id, { limit: 200 }).items;
    const md = items
      .map((s) => {
        const r = s.revision;
        return [`## ${r?.title ?? "Snip"}`, ``, `${s.show_title ?? ""} · ${s.episode_title}`, `${s.share_url}`, ``, r?.summary ? `${r.summary}\n` : "", r?.excerpt ? `> ${r.excerpt}\n` : "", s.note ? `Note: ${s.note}\n` : ""].join("\n");
      })
      .join("\n");
    return reply.header("Content-Type", "text/markdown; charset=utf-8").send(md);
  });
}
