import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import * as S from "../schemas.js";

const Id = Type.Object({ id: Type.String() });
import { notFound, tooManyRequests, unauthorized } from "../../app/errors.js";
import type { DeviceRow } from "../../db/rows.js";
import { cookieHeader, createDevice, passwordMatches } from "../auth.js";
import { LoginLimiter } from "../loginLimiter.js";

export function registerDevicesRoutes(instance: FastifyInstance, ctx: AppContext): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();
  const limiter = new LoginLimiter(ctx.now);
  app.post("/v1/devices", { schema: { tags: ["devices"], security: [], summary: "Log in and mint a device token. Ten wrong passwords from one address within an hour lock that address out until the oldest ages out (429 with Retry-After)", body: S.CreateDeviceBody, response: { 201: S.CreateDeviceResponse, 401: S.ErrorSchema, 429: S.ErrorSchema } } }, async (request, reply) => {
    // request.ip is the visitor's address: nginx forwards CF-Connecting-IP and Fastify trusts the proxy.
    const wait = limiter.retryAfterMs(request.ip);
    if (wait > 0) {
      ctx.log("login locked out", { ip: request.ip });
      reply.header("Retry-After", String(Math.ceil(wait / 1000)));
      throw tooManyRequests("too many wrong passwords; try again later");
    }
    if (!passwordMatches(request.body.password, ctx.config.ownerPassword)) {
      limiter.recordFailure(request.ip);
      ctx.log("login failed", { ip: request.ip, device_name: request.body.name });
      throw unauthorized("wrong password");
    }
    limiter.recordSuccess(request.ip);
    const { device, token } = createDevice(ctx, { name: request.body.name, platform: request.body.platform });
    // Secure follows the scheme this request arrived over (X-Forwarded-Proto behind the tunnel's proxy), not
    // PUBLIC_BASE_URL: a browser drops a Secure cookie sent over plain http, which would break the dev server
    // on the tailnet while the public origin is https.
    if (request.body.set_cookie) reply.header("Set-Cookie", cookieHeader(token, request.protocol === "https"));
    return reply.code(201).send({ device: deviceView(device), token });
  });
  app.get("/v1/devices", { schema: { tags: ["devices"], summary: "List this owner's devices, including revoked ones", response: { 200: Type.Array(S.DeviceSchema) } } }, async () => {
    return (ctx.db.prepare("SELECT * FROM device ORDER BY created_at").all() as DeviceRow[]).map(deviceView);
  });
  app.delete("/v1/devices/:id", { schema: { tags: ["devices"], summary: "Revoke a device token", params: Id, response: { 204: Type.Null() } } }, async (request, reply) => {
    const r = ctx.db.prepare("UPDATE device SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(ctx.now(), request.params.id);
    if (r.changes === 0) throw notFound("device");
    return reply.code(204).send(null);
  });
}

function deviceView(d: DeviceRow) {
  return { id: d.id, name: d.name, platform: d.platform, created_at: d.created_at, last_seen_at: d.last_seen_at, revoked_at: d.revoked_at };
}
