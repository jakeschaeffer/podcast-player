import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../app/context.js";

export type MediaKind = "asset" | "clip" | "video";

/**
 * Signed, expiring media URLs: `/m/assets/{asset_id}`, `/m/videos/{asset_id}` (the recording's video file) and
 * `/m/clips/{revision_id}`, each with `?e=<expiry>&d=<device>&s=<hmac>`.
 * A plain URL is the only thing `<audio>`, AVPlayer, and background downloads all accept without custom headers.
 */
export function signMediaUrl(ctx: AppContext, kind: MediaKind, id: string, deviceId: string, ttlSeconds = ctx.config.mediaUrlTtlSeconds): string {
  const e = Math.floor(ctx.now() / 1000) + ttlSeconds;
  const s = ctx.secrets.sign(`${kind}|${id}|${e}|${deviceId}`);
  return `${ctx.config.publicBaseUrl}/m/${kind}s/${id}?e=${e}&d=${encodeURIComponent(deviceId)}&s=${s}`;
}

export function verifyMediaSignature(ctx: AppContext, kind: MediaKind, id: string, query: { e?: string; d?: string; s?: string }): boolean {
  if (!query.e || !query.d || !query.s) return false;
  const e = Number(query.e);
  if (!Number.isFinite(e) || e * 1000 < ctx.now()) return false;
  if (!ctx.secrets.verify(`${kind}|${id}|${query.e}|${query.d}`, query.s)) return false;
  // Logging a device out also stops the audio URLs it was handed, instead of letting them run to expiry.
  const device = ctx.db.prepare("SELECT revoked_at FROM device WHERE id = ?").get(query.d) as { revoked_at: number | null } | undefined;
  return device !== undefined && device.revoked_at === null;
}

export type FileServeOptions = { mime: string; etag: string; cacheControl: string; filename?: string };

/**
 * Serve a file with correct single-range support. Used for source audio, owner clip previews, and public clips.
 * Only the given path is ever read; callers decide what the path is.
 */
export async function sendFile(request: FastifyRequest, reply: FastifyReply, path: string, opts: FileServeOptions): Promise<void> {
  const { size } = await stat(path);
  reply.header("Accept-Ranges", "bytes");
  reply.header("ETag", `"${opts.etag}"`);
  reply.header("Cache-Control", opts.cacheControl);
  reply.header("Content-Type", opts.mime);
  if (opts.filename) reply.header("Content-Disposition", `inline; filename="${opts.filename}"`);

  if (request.headers["if-none-match"] === `"${opts.etag}"`) {
    reply.code(304);
    return reply.send();
  }

  const range = parseRange(request.headers.range, size);
  if (range === "unsatisfiable") {
    reply.code(416).header("Content-Range", `bytes */${size}`);
    return reply.send();
  }
  if (request.method === "HEAD") {
    reply.header("Content-Length", String(size));
    return reply.send();
  }
  if (range) {
    reply.code(206);
    reply.header("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
    reply.header("Content-Length", String(range.end - range.start + 1));
    return reply.send(createReadStream(path, { start: range.start, end: range.end }));
  }
  reply.header("Content-Length", String(size));
  return reply.send(createReadStream(path));
}

/** One byte range per RFC 9110; multi-range requests fall back to the whole file. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  const m = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return null;
  const [, a, b] = m;
  if (a === "" && b === "") return null;
  let start: number;
  let end: number;
  if (a === "") {
    const suffix = Number(b);
    if (suffix === 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return "unsatisfiable";
  return { start, end };
}
