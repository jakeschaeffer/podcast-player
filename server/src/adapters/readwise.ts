/**
 * Readwise's highlights API (https://readwise.io/api_deets), the part a snip needs: create a highlight, change its
 * text, note and place, and delete it. The token is the owner's own (https://readwise.io/access_token).
 */
import { NonRetryable } from "../jobs/errors.js";

/** One highlight as Readwise's create endpoint takes it. Readwise files it under a "book" by title and author. */
export type ReadwiseHighlight = {
  text: string;
  title: string;
  author?: string;
  image_url?: string;
  source_url?: string;
  source_type: string;
  category: "podcasts";
  note?: string;
  /** Seconds from the start of the recording, with `location_type: "time_offset"`. */
  location: number;
  location_type: "time_offset";
  /** ISO 8601. */
  highlighted_at: string;
  /** Unique per highlight: Readwise updates the highlight that already has this URL instead of adding another. */
  highlight_url: string;
};

/** What can change on a highlight Readwise already has. Its book (title, author, cover) stays as first sent. */
export type ReadwiseHighlightPatch = { text: string; note: string; location: number; url: string };

export interface Readwise {
  readonly name: string;
  /** The new (or, for a known `highlight_url`, updated) highlight's id, when Readwise says which it is. */
  create(highlight: ReadwiseHighlight): Promise<{ highlight_id: number | null }>;
  /** "gone" when Readwise no longer has the highlight: the owner deleted it there. */
  update(id: number, patch: ReadwiseHighlightPatch): Promise<"ok" | "gone">;
  remove(id: number): Promise<"ok" | "gone">;
}

const BASE = "https://readwise.io/api/v2";

export class ReadwiseApi implements Readwise {
  readonly name = "readwise";
  constructor(private readonly opts: { token: string; fetch?: typeof fetch; base?: string }) {}

  async create(highlight: ReadwiseHighlight): Promise<{ highlight_id: number | null }> {
    const res = await this.call("POST", "/highlights/", { highlights: [highlight] });
    const books = (await res.json()) as { modified_highlights?: unknown }[];
    const ids = Array.isArray(books) ? books.flatMap((b) => (Array.isArray(b.modified_highlights) ? b.modified_highlights : [])) : [];
    const id = ids.find((x): x is number => typeof x === "number");
    return { highlight_id: id ?? null };
  }

  async update(id: number, patch: ReadwiseHighlightPatch): Promise<"ok" | "gone"> {
    const res = await this.call("PATCH", `/highlights/${id}/`, patch, { missingOk: true });
    return res.status === 404 ? "gone" : "ok";
  }

  async remove(id: number): Promise<"ok" | "gone"> {
    const res = await this.call("DELETE", `/highlights/${id}/`, undefined, { missingOk: true });
    return res.status === 404 ? "gone" : "ok";
  }

  /** A refused token or a rejected highlight will not pass on a retry; a rate limit, a 5xx or the network may. */
  private async call(method: string, path: string, body: unknown, opts: { missingOk?: boolean } = {}): Promise<Response> {
    const res = await (this.opts.fetch ?? fetch)(`${this.opts.base ?? BASE}${path}`, {
      method,
      headers: { Authorization: `Token ${this.opts.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok || (opts.missingOk && res.status === 404)) return res;
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    const message = `Readwise ${method} ${path} answered ${res.status}${detail ? `: ${detail}` : ""}`;
    if (res.status === 401 || res.status === 403) throw new NonRetryable(`${message} (check READWISE_TOKEN)`);
    if (res.status === 429 || res.status >= 500) throw new Error(message);
    throw new NonRetryable(message);
  }
}
