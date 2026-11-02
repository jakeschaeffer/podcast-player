/**
 * Minimal Gmail API client for read-only access to the owner's mailbox, used by the email content source.
 * Credentials: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (a Desktop OAuth client) and GOOGLE_REFRESH_TOKEN,
 * minted once by `pnpm gmail:auth` with the `gmail.readonly` scope. Nothing here can send, modify, or delete.
 */
import { htmlToText } from "./sanitize.js";

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
/** Loopback redirect for the Desktop-app flow; nothing listens there, the code is read from the address bar. */
export const LOOPBACK_REDIRECT = "http://127.0.0.1:8765/";

export type GoogleCredentials = { client_id: string; client_secret: string; refresh_token: string };

export function credentialsFromEnv(env: NodeJS.ProcessEnv = process.env): GoogleCredentials | null {
  const client_id = env.GOOGLE_CLIENT_ID;
  const client_secret = env.GOOGLE_CLIENT_SECRET;
  const refresh_token = env.GOOGLE_REFRESH_TOKEN;
  return client_id && client_secret && refresh_token ? { client_id, client_secret, refresh_token } : null;
}

export function authorizationUrl(client_id: string): string {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", client_id);
  u.searchParams.set("redirect_uri", LOOPBACK_REDIRECT);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GMAIL_SCOPE);
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  return u.toString();
}

/** Accepts the full redirect URL from the address bar, or a bare code. */
export function codeFromRedirect(input: string): string {
  const s = input.trim();
  if (s.startsWith("http")) {
    const code = new URL(s).searchParams.get("code");
    if (!code) throw new Error("redirect URL has no code parameter");
    return code;
  }
  return decodeURIComponent(s);
}

export async function exchangeCode(client_id: string, client_secret: string, code: string): Promise<{ refresh_token: string; access_token: string }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id, client_secret, redirect_uri: LOOPBACK_REDIRECT, grant_type: "authorization_code" }),
  });
  const body = (await res.json()) as { refresh_token?: string; access_token?: string; error?: string; error_description?: string };
  if (!res.ok || !body.refresh_token || !body.access_token) {
    throw new Error(`token exchange failed: ${body.error ?? res.status} ${body.error_description ?? ""}`.trim());
  }
  return { refresh_token: body.refresh_token, access_token: body.access_token };
}

export class GmailClient {
  private accessToken: { value: string; expires_at: number } | null = null;
  constructor(private readonly creds: GoogleCredentials) {}

  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expires_at > Date.now() + 30_000) return this.accessToken.value;
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.creds.client_id, client_secret: this.creds.client_secret, refresh_token: this.creds.refresh_token, grant_type: "refresh_token" }),
    });
    const body = (await res.json()) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !body.access_token) throw new Error(`token refresh failed: ${body.error ?? res.status} ${body.error_description ?? ""}`.trim());
    this.accessToken = { value: body.access_token, expires_at: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }

  /** Gmail allows 250 quota units per second per user and a message fetch costs 5; pace calls and back off on quota errors. */
  private lastCall = 0;
  private async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const u = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastCall + 120 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastCall = Date.now();
      const res = await fetch(u, { headers: { authorization: `Bearer ${await this.token()}` } });
      if (res.ok) return (await res.json()) as T;
      const body = await res.text();
      const quota = res.status === 429 || (res.status === 403 && /quota|rate/i.test(body));
      if (quota && attempt < 6) {
        await new Promise((r) => setTimeout(r, Math.min(60_000, 2_000 * 2 ** attempt)));
        continue;
      }
      throw new Error(`gmail ${path}: ${res.status} ${body.slice(0, 300)}`);
    }
  }

  async profile(): Promise<{ emailAddress: string; messagesTotal: number }> {
    return this.get("profile");
  }

  async listMessages(q: string, maxResults = 20): Promise<{ id: string; threadId: string }[]> {
    const out: { id: string; threadId: string }[] = [];
    let pageToken: string | undefined;
    while (out.length < maxResults) {
      const page = await this.get<{ messages?: { id: string; threadId: string }[]; nextPageToken?: string }>("messages", { q, maxResults: String(Math.min(100, maxResults - out.length)), ...(pageToken ? { pageToken } : {}) });
      out.push(...(page.messages ?? []));
      if (!page.nextPageToken) break;
      pageToken = page.nextPageToken;
    }
    return out.slice(0, maxResults);
  }

  async getMessage(id: string): Promise<GmailMessage> {
    const raw = await this.get<RawMessage>(`messages/${id}`, { format: "full" });
    const headers = Object.fromEntries((raw.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]));
    const parts = flattenParts(raw.payload);
    const plain = parts.find((p) => p.mimeType === "text/plain")?.body;
    const html = parts.find((p) => p.mimeType === "text/html")?.body;
    return {
      id: raw.id,
      thread_id: raw.threadId,
      date: Number(raw.internalDate),
      from: headers["from"] ?? "",
      subject: headers["subject"] ?? "",
      text: plain ? decodeBody(plain) : html ? htmlToText(decodeBody(html)) : "",
      html: html ? decodeBody(html) : null,
    };
  }
}

export type GmailMessage = { id: string; thread_id: string; date: number; from: string; subject: string; text: string; html: string | null };

type RawPart = { mimeType?: string; body?: { data?: string; size?: number }; parts?: RawPart[]; headers?: { name: string; value: string }[] };
type RawMessage = { id: string; threadId: string; internalDate: string; payload?: RawPart };

function flattenParts(p: RawPart | undefined): { mimeType: string; body: string }[] {
  if (!p) return [];
  const own = p.body?.data && p.mimeType ? [{ mimeType: p.mimeType, body: p.body.data }] : [];
  return [...own, ...(p.parts ?? []).flatMap(flattenParts)];
}

function decodeBody(b64url: string): string {
  return Buffer.from(b64url.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}
