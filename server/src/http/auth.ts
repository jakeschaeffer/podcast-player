import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../app/context.js";
import { unauthorized } from "../app/errors.js";
import type { DeviceRow } from "../db/rows.js";
import { hashToken, newDeviceToken } from "../lib/crypto.js";
import { newId } from "../lib/ids.js";

export const COOKIE_NAME = "pp_device";

declare module "fastify" {
  interface FastifyRequest {
    device: DeviceRow;
  }
}

export function passwordMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createDevice(ctx: AppContext, input: { name: string; platform: string }): { device: DeviceRow; token: string } {
  const token = newDeviceToken();
  const id = newId();
  ctx.db.prepare("INSERT INTO device (id, name, platform, token_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(id, input.name, input.platform, hashToken(token), ctx.now());
  return { device: ctx.db.prepare("SELECT * FROM device WHERE id = ?").get(id) as DeviceRow, token };
}

export function tokenFromRequest(request: FastifyRequest): string | null {
  const auth = request.headers.authorization;
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim();
  const cookie = request.headers.cookie;
  if (cookie) {
    const m = cookie.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE_NAME}=`));
    if (m) return decodeURIComponent(m.slice(COOKIE_NAME.length + 1));
  }
  return null;
}

/** The live device a request's bearer token or cookie belongs to, or null. */
export function deviceForRequest(ctx: AppContext, request: FastifyRequest): DeviceRow | null {
  const token = tokenFromRequest(request);
  if (!token) return null;
  return (ctx.db.prepare("SELECT * FROM device WHERE token_hash = ? AND revoked_at IS NULL").get(hashToken(token)) as DeviceRow | undefined) ?? null;
}

/** Owner routes: a bearer token or the web cookie must resolve to a live device. */
export function requireDevice(ctx: AppContext) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!tokenFromRequest(request)) throw unauthorized();
    const device = deviceForRequest(ctx, request);
    if (!device) throw unauthorized("invalid or revoked token");
    request.device = device;
    const now = ctx.now();
    if (!device.last_seen_at || now - device.last_seen_at > 60_000) ctx.db.prepare("UPDATE device SET last_seen_at = ? WHERE id = ?").run(now, device.id);
  };
}

export function cookieHeader(token: string, secure: boolean): string {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure ? "; Secure" : ""}`;
}

export function registerAuthHook(app: FastifyInstance, ctx: AppContext): void {
  const check = requireDevice(ctx);
  app.addHook("onRequest", async (request, reply) => {
    const url = request.raw.url ?? "";
    if (!url.startsWith("/v1/")) return;
    if (request.method === "POST" && url.split("?")[0] === "/v1/devices") return;
    // Liveness stays public for uptime checks; it reports queue counts only to an authenticated caller.
    if (url.split("?")[0] === "/v1/health") return;
    await check(request, reply);
  });
}
