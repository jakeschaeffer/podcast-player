/**
 * Finding public shows to subscribe to. The iTunes Search API needs no key and returns the feed URL for most
 * shows; Podcast Index (podcastindex.org) is the open alternative with better coverage of new shows and the
 * podcast namespace, used when its credentials are configured.
 */
import { createHash } from "node:crypto";

export type ShowResult = {
  title: string;
  author: string | null;
  feed_url: string;
  artwork_url: string | null;
  site_url: string | null;
  episode_count: number | null;
  genres: string[];
  source: "itunes" | "podcastindex";
};

export interface ShowSearch {
  readonly name: string;
  search(query: string, limit?: number): Promise<ShowResult[]>;
}

export class ItunesShowSearch implements ShowSearch {
  readonly name = "itunes";
  async search(query: string, limit = 10): Promise<ShowResult[]> {
    const u = new URL("https://itunes.apple.com/search");
    u.searchParams.set("media", "podcast");
    u.searchParams.set("entity", "podcast");
    u.searchParams.set("term", query);
    u.searchParams.set("limit", String(Math.min(50, limit)));
    const res = await fetch(u, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`itunes search: ${res.status}`);
    const body = (await res.json()) as { results?: { collectionName?: string; artistName?: string; feedUrl?: string; artworkUrl600?: string; artworkUrl100?: string; collectionViewUrl?: string; trackCount?: number; genres?: string[] }[] };
    return (body.results ?? [])
      .filter((r) => typeof r.feedUrl === "string" && r.feedUrl.length > 0)
      .map((r) => ({
        title: r.collectionName ?? "(untitled)",
        author: r.artistName ?? null,
        feed_url: r.feedUrl!,
        artwork_url: r.artworkUrl600 ?? r.artworkUrl100 ?? null,
        site_url: r.collectionViewUrl ?? null,
        episode_count: typeof r.trackCount === "number" ? r.trackCount : null,
        genres: (r.genres ?? []).filter((g) => g !== "Podcasts"),
        source: "itunes" as const,
      }));
  }
}

export class PodcastIndexShowSearch implements ShowSearch {
  readonly name = "podcastindex";
  constructor(private readonly key: string, private readonly secret: string) {}
  async search(query: string, limit = 10): Promise<ShowResult[]> {
    const time = Math.floor(Date.now() / 1000);
    const auth = createHash("sha1").update(`${this.key}${this.secret}${time}`).digest("hex");
    const u = new URL("https://api.podcastindex.org/api/1.0/search/byterm");
    u.searchParams.set("q", query);
    u.searchParams.set("max", String(Math.min(40, limit)));
    const res = await fetch(u, { headers: { "X-Auth-Key": this.key, "X-Auth-Date": String(time), Authorization: auth, "User-Agent": "podcast-player/0.1" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`podcastindex search: ${res.status}`);
    const body = (await res.json()) as { feeds?: { title?: string; author?: string; url?: string; artwork?: string; image?: string; link?: string; episodeCount?: number; categories?: Record<string, string> }[] };
    return (body.feeds ?? [])
      .filter((f) => typeof f.url === "string")
      .map((f) => ({
        title: f.title ?? "(untitled)",
        author: f.author ?? null,
        feed_url: f.url!,
        artwork_url: f.artwork ?? f.image ?? null,
        site_url: f.link ?? null,
        episode_count: typeof f.episodeCount === "number" ? f.episodeCount : null,
        genres: Object.values(f.categories ?? {}),
        source: "podcastindex" as const,
      }));
  }
}

export function showSearchFromEnv(env: NodeJS.ProcessEnv = process.env): ShowSearch {
  return env.PODCASTINDEX_KEY && env.PODCASTINDEX_SECRET ? new PodcastIndexShowSearch(env.PODCASTINDEX_KEY, env.PODCASTINDEX_SECRET) : new ItunesShowSearch();
}
