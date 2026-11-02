import { createWriteStream } from "node:fs";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { Agent, fetch as undiciFetch } from "undici";

export type SafeFetchOptions = {
  headers?: Record<string, string>;
  maxRedirects?: number;
  /** Abort if the body exceeds this many bytes. */
  maxBytes?: number;
  timeoutMs?: number;
  /** Tests may allow loopback targets. Never set in production. */
  allowPrivateNetwork?: boolean;
  /** Accept response headers up to this size; fetch's default is 16 KiB, and a YouTube page sends more. */
  maxHeaderSize?: number;
};

export type SafeFetchResult = {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  finalUrl: string;
};

const DEFAULTS = { maxRedirects: 5, maxBytes: 2 * 1024 * 1024 * 1024, timeoutMs: 60_000 };

/** One agent per header limit, kept: an agent holds its connections, so it is not made per request. */
const agents = new Map<number, Agent>();
function agentFor(maxHeaderSize: number): Agent {
  let agent = agents.get(maxHeaderSize);
  if (!agent) {
    agent = new Agent({ maxHeaderSize });
    agents.set(maxHeaderSize, agent);
  }
  return agent;
}

/**
 * Fetch a feed-supplied URL without letting it reach anything internal.
 * Redirects are followed one hop at a time and every hop is checked: https or http only,
 * a hostname that does not resolve to loopback, private, link-local, or metadata addresses.
 * Credentials embedded in the URL (private feeds) are sent as Basic auth to that host only.
 */
export async function safeFetch(url: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const maxRedirects = opts.maxRedirects ?? DEFAULTS.maxRedirects;
  let current = new URL(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("fetch timeout")), opts.timeoutMs ?? DEFAULTS.timeoutMs);
  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      await assertPublicTarget(current, opts.allowPrivateNetwork ?? false);
      const headers = new Headers(opts.headers ?? {});
      if (!headers.has("user-agent")) headers.set("user-agent", "podcast-player/0.1 (+https://github.com/)");
      if (current.username || current.password) {
        headers.set("authorization", `Basic ${Buffer.from(`${decodeURIComponent(current.username)}:${decodeURIComponent(current.password)}`).toString("base64")}`);
      }
      const bare = new URL(current.toString());
      bare.username = "";
      bare.password = "";
      const res = opts.maxHeaderSize
        ? ((await undiciFetch(bare, { headers, redirect: "manual", signal: controller.signal, dispatcher: agentFor(opts.maxHeaderSize) })) as unknown as Response)
        : await fetch(bare, { headers, redirect: "manual", signal: controller.signal });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        await res.body?.cancel();
        if (hop === maxRedirects) throw new Error(`too many redirects fetching ${redact(url)}`);
        current = new URL(res.headers.get("location")!, current);
        continue;
      }
      const length = Number(res.headers.get("content-length"));
      if (Number.isFinite(length) && length > (opts.maxBytes ?? DEFAULTS.maxBytes)) {
        await res.body?.cancel();
        throw new Error(`response too large (${length} bytes)`);
      }
      return { status: res.status, headers: res.headers, body: res.body, finalUrl: bare.toString() };
    }
    throw new Error("unreachable");
  } finally {
    // The timer only guards connection and headers; body streaming has its own cap in downloadToFile.
    clearTimeout(timer);
  }
}

/** Stream a response body to disk, enforcing the byte cap, and return the byte count. */
export async function downloadToFile(res: SafeFetchResult, path: string, maxBytes = DEFAULTS.maxBytes): Promise<number> {
  if (!res.body) throw new Error("empty body");
  let total = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      total += chunk.length;
      if (total > maxBytes) cb(new Error(`download exceeded ${maxBytes} bytes`));
      else cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body as import("stream/web").ReadableStream<Uint8Array>), counter, createWriteStream(path));
  return total;
}

export async function assertPublicTarget(url: URL, allowPrivate: boolean): Promise<void> {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`unsupported protocol ${url.protocol}`);
  if (allowPrivate) return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host === "metadata.google.internal") {
    throw new Error(`refusing to fetch ${host}`);
  }
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
  if (addresses.length === 0) throw new Error(`cannot resolve ${host}`);
  for (const a of addresses) {
    if (isPrivateAddress(a.address)) throw new Error(`refusing to fetch ${host}: resolves to ${a.address}`);
  }
}

/** Loopback, RFC 1918, link-local (including 169.254.169.254), CGNAT, unique-local IPv6, and unspecified. */
export function isPrivateAddress(address: string): boolean {
  const v = isIP(address);
  if (v === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number, number, number];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (v === 6) {
    const lower = address.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return false;
  }
  return true;
}

/** Strip credentials and query strings for logs. */
export function redact(url: string): string {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    u.search = "";
    return u.toString();
  } catch {
    return "<invalid url>";
  }
}
