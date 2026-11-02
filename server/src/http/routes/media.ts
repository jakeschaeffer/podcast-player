import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";

import { notFound, unauthorized } from "../../app/errors.js";
import type { SnipRevisionRow } from "../../db/rows.js";
import { getAssetRow } from "../../services/episodes.js";
import { sendFile, verifyMediaSignature } from "../../services/media.js";

export function registerMediaRoutes(instance: FastifyInstance, ctx: AppContext): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();
  const SignedQuery = Type.Object({ e: Type.String(), d: Type.String(), s: Type.String() });
  app.get("/m/assets/:asset_id", { schema: { tags: ["media"], security: [], hide: true, params: Type.Object({ asset_id: Type.String() }), querystring: SignedQuery } }, async (request, reply) => {
    if (!verifyMediaSignature(ctx, "asset", request.params.asset_id, request.query)) throw unauthorized("bad or expired signature");
    const asset = getAssetRow(ctx, request.params.asset_id);
    return sendFile(request, reply, asset.path, { mime: asset.mime, etag: asset.sha256, cacheControl: "private, max-age=86400" });
  });
  app.get("/m/videos/:asset_id", { schema: { tags: ["media"], security: [], hide: true, params: Type.Object({ asset_id: Type.String() }), querystring: SignedQuery } }, async (request, reply) => {
    if (!verifyMediaSignature(ctx, "video", request.params.asset_id, request.query)) throw unauthorized("bad or expired signature");
    const asset = getAssetRow(ctx, request.params.asset_id);
    if (!asset.video_path || !asset.video_sha256) throw notFound("video");
    ctx.db.prepare("UPDATE audio_asset SET video_last_played_at = ? WHERE id = ?").run(ctx.now(), asset.id);
    return sendFile(request, reply, asset.video_path, { mime: "video/mp4", etag: asset.video_sha256, cacheControl: "private, max-age=86400" });
  });
  app.get("/m/clips/:revision_id", { schema: { tags: ["media"], security: [], hide: true, params: Type.Object({ revision_id: Type.String() }), querystring: SignedQuery } }, async (request, reply) => {
    if (!verifyMediaSignature(ctx, "clip", request.params.revision_id, request.query)) throw unauthorized("bad or expired signature");
    const rev = ctx.db.prepare("SELECT * FROM snip_revision WHERE id = ?").get(request.params.revision_id) as SnipRevisionRow | undefined;
    if (!rev?.clip_path) throw notFound("clip");
    return sendFile(request, reply, rev.clip_path, { mime: "audio/mpeg", etag: rev.clip_sha256 ?? rev.id, cacheControl: "private, max-age=86400" });
  });
}
