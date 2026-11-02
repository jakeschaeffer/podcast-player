import createClient, { type Middleware } from "openapi-fetch";
import { session } from "../auth/session";
import type { paths } from "./schema";

/** Same-origin client: the Vite proxy (dev) or nginx (prod) puts /v1, /m, and /s next to the app, so the cookie just works. */
export const api = createClient<paths>({ baseUrl: "" });

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
  /** Status 0 means the request never reached the server (offline, proxy down). */
  get isNetwork(): boolean {
    return this.status === 0;
  }
}

const expireOnUnauthorized: Middleware = {
  async onResponse({ request, response }) {
    const isLogin = request.method === "POST" && new URL(request.url).pathname === "/v1/devices";
    if (response.status === 401 && !isLogin) session.expire();
    return response;
  },
};
api.use(expireOnUnauthorized);

type Result<T> = { data?: T; error?: unknown; response: Response };

/** Resolve an openapi-fetch call to its JSON, or throw an ApiError carrying the server's code and message. */
export async function unwrap<T>(call: Promise<Result<T>>): Promise<T> {
  let r: Result<T>;
  try {
    r = await call;
  } catch (e) {
    throw new ApiError(0, "network", e instanceof Error ? e.message : "network error");
  }
  if (!r.response.ok) {
    const body = r.error as { error?: { code?: string; message?: string } } | undefined;
    throw new ApiError(r.response.status, body?.error?.code ?? "request", body?.error?.message ?? `HTTP ${r.response.status}`);
  }
  return r.data as T;
}

export function describeError(e: unknown): string {
  if (e instanceof ApiError) return e.isNetwork ? "No connection" : e.message;
  return e instanceof Error ? e.message : String(e);
}
