/** What stays safe once /v1 and /m are reachable without Cloudflare Access in front of them. */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/http/app.js";
import { LoginLimiter } from "../src/http/loginLimiter.js";
import { makeTone, recordingFixture } from "./helpers/fixture.js";

let app: FastifyInstance;
let clock: { now: number };
let episodeId: string;

const loginFrom = (ip: string, password: string) =>
  app.inject({ method: "POST", url: "/v1/devices", headers: { "x-forwarded-for": ip }, payload: { name: "phone", platform: "ios", password } });

beforeAll(async () => {
  const fx = recordingFixture(await makeTone());
  ({ clock, episodeId } = fx);
  app = await buildApp(fx.ctx);
});

afterAll(async () => {
  await app.close();
});

describe("login lockout", () => {
  it("locks one address out after ten wrong passwords in an hour, without locking anyone else out", async () => {
    for (let i = 0; i < 10; i++) expect((await loginFrom("203.0.113.5", "wrong")).statusCode).toBe(401);
    const locked = await loginFrom("203.0.113.5", "hunter2"); // even the right password waits
    expect(locked.statusCode).toBe(429);
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
    expect((await loginFrom("198.51.100.7", "hunter2")).statusCode).toBe(201);

    clock.now += 3_600_001;
    expect((await loginFrom("203.0.113.5", "hunter2")).statusCode).toBe(201);
  });

  it("forgets an address's failures once it logs in, and bounds its memory", () => {
    let now = 0;
    const limiter = new LoginLimiter(() => now, { maxFailures: 2, windowMs: 1000, maxKeys: 2 });
    limiter.recordFailure("a");
    limiter.recordFailure("a");
    expect(limiter.retryAfterMs("a")).toBe(1000);
    limiter.recordSuccess("a");
    expect(limiter.retryAfterMs("a")).toBe(0);
    for (const key of ["b", "c", "d"]) {
      limiter.recordFailure(key);
      limiter.recordFailure(key);
    }
    expect(limiter.retryAfterMs("b")).toBe(0); // evicted: the oldest key goes first
    expect(limiter.retryAfterMs("d")).toBe(1000);
    now = 1001;
    expect(limiter.retryAfterMs("d")).toBe(0);
  });
});

describe("unauthenticated surface", () => {
  it("keeps health public but shows queue counts only to a device, and puts the API description behind a token", async () => {
    const token = (await loginFrom("192.0.2.1", "hunter2")).json().token as string;
    expect((await app.inject({ method: "GET", url: "/v1/health" })).json()).toEqual({ ok: true });
    expect((await app.inject({ method: "GET", url: "/v1/health", headers: { authorization: `Bearer ${token}` } })).json()).toMatchObject({ ok: true, jobs: expect.any(Object) });
    expect((await app.inject({ method: "GET", url: "/v1/openapi.json" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/openapi.json", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
  });

  it("stops a device's signed audio URLs when the device is logged out", async () => {
    const login = (await loginFrom("192.0.2.2", "hunter2")).json() as { token: string; device: { id: string } };
    const headers = { authorization: `Bearer ${login.token}` };
    const ep = (await app.inject({ method: "GET", url: `/v1/episodes/${episodeId}`, headers })).json();
    const audioPath = new URL(ep.asset.audio_url).pathname + new URL(ep.asset.audio_url).search;
    expect((await app.inject({ method: "GET", url: audioPath, headers: { range: "bytes=0-9" } })).statusCode).toBe(206);

    expect((await app.inject({ method: "DELETE", url: `/v1/devices/${login.device.id}`, headers })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: audioPath, headers: { range: "bytes=0-9" } })).statusCode).toBe(401);
  });
});
