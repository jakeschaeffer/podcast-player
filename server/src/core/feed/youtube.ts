/**
 * YouTube as a source (docs/video-plan.md): a channel's public Atom feed, and the video a podcast episode's show
 * notes link ("Watch on YouTube"). Pure: no network, no clock.
 */
import { XMLParser } from "fast-xml-parser";

const ID = /^[A-Za-z0-9_-]{11}$/;

/** A YouTube video id (11 characters) from any of the URL forms the web uses, or null. */
export function youtubeIdFrom(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\.|^m\.|^music\./, "");
  let id: string | null = null;
  if (host === "youtu.be") id = u.pathname.slice(1).split("/")[0] ?? null;
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (u.pathname === "/watch") id = u.searchParams.get("v");
    else {
      const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?]+)/);
      id = m?.[1] ?? null;
    }
  }
  return id && ID.test(id) ? id : null;
}

/**
 * The one video an episode's show notes link, as the id, or null when they link none or several (a page that lists
 * other episodes, say, is not this episode's video).
 */
export function youtubeIdIn(html: string | null): string | null {
  if (!html) return null;
  const ids = new Set<string>();
  for (const m of html.matchAll(/https?:\/\/[^\s"'<>]+/g)) {
    const id = youtubeIdFrom(m[0].replace(/[),.;!?]+$/, ""));
    if (id) ids.add(id);
  }
  return ids.size === 1 ? [...ids][0]! : null;
}

export type YouTubeChannel = { channel_id: string; title: string | null; author: string | null; site_url: string | null };
export type YouTubeVideo = {
  video_id: string;
  title: string;
  /** The description as the feed gives it: plain text with line breaks. */
  description: string | null;
  published_at: number | null;
  thumbnail_url: string | null;
  link: string;
};

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text", isArray: (name) => name === "entry" || name === "link" });

/**
 * A channel's feed, `https://www.youtube.com/feeds/videos.xml?channel_id=UC…`: the latest fifteen videos. The feed
 * says nothing about length, so Shorts can only be told apart later, from the video itself.
 */
export function parseYouTubeFeed(xml: string): { channel: YouTubeChannel; videos: YouTubeVideo[] } {
  const doc = parser.parse(xml) as Record<string, unknown>;
  const feed = doc["feed"] as Record<string, unknown> | undefined;
  if (!feed || typeof feed !== "object" || typeof feed["yt:channelId"] !== "string") throw new Error("not a YouTube channel feed");
  const channel_id = String(feed["yt:channelId"]);
  const author = feed["author"] as Record<string, unknown> | undefined;
  const channel: YouTubeChannel = {
    channel_id,
    title: str(feed["title"]),
    author: str(author?.["name"]),
    site_url: alternate(feed["link"]) ?? `https://www.youtube.com/channel/${channel_id}`,
  };
  const videos: YouTubeVideo[] = [];
  for (const raw of (feed["entry"] as unknown[] | undefined) ?? []) {
    const e = raw as Record<string, unknown>;
    const video_id = str(e["yt:videoId"]);
    if (!video_id || !ID.test(video_id)) continue;
    const group = e["media:group"] as Record<string, unknown> | undefined;
    const thumb = group?.["media:thumbnail"] as Record<string, unknown> | undefined;
    const published = str(e["published"]);
    const t = published ? Date.parse(published) : NaN;
    videos.push({
      video_id,
      title: str(e["title"]) ?? str(group?.["media:title"]) ?? "(untitled)",
      description: str(group?.["media:description"]),
      published_at: Number.isFinite(t) ? t : null,
      thumbnail_url: typeof thumb?.["@_url"] === "string" ? thumb["@_url"] : null,
      link: alternate(e["link"]) ?? `https://www.youtube.com/watch?v=${video_id}`,
    });
  }
  return { channel, videos };
}

/**
 * The channel id from a channel page's HTML, or null. The page's canonical link names its own channel; so does its
 * metadata's `externalId`. A `channelId` found first on the page can belong to another channel the page shows.
 */
export function channelIdInPage(html: string): string | null {
  const m = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})"/) ?? html.match(/"externalId":"(UC[A-Za-z0-9_-]{22})"/);
  return m?.[1] ?? null;
}

/** A video as its watch page describes it (`parseWatchPage`). */
export type YouTubeWatch = {
  video_id: string;
  channel_id: string;
  channel_name: string | null;
  title: string;
  description: string | null;
  published_at: number | null;
  duration_ms: number | null;
  thumbnail_url: string | null;
  link: string;
};

/**
 * What a video's watch page says about it, or null when the page does not name the channel that owns it (a consent
 * page, an unavailable video). The page's Open Graph and schema.org tags carry the title, the thumbnail and the
 * length; `externalChannelId` is the owner's channel, where a bare `channelId` can name a channel the page recommends.
 */
export function parseWatchPage(html: string, videoId: string): YouTubeWatch | null {
  const channel_id = html.match(/"externalChannelId":"(UC[A-Za-z0-9_-]{22})"/)?.[1] ?? html.match(/<meta itemprop="channelId" content="(UC[A-Za-z0-9_-]{22})"/)?.[1] ?? null;
  if (!channel_id) return null;
  const meta = (attr: string, name: string) => {
    const m = html.match(new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`));
    return m ? decodeEntities(m[1]!) : null;
  };
  const title = meta("property", "og:title") ?? meta("name", "title");
  if (!title) return null;
  const published = meta("itemprop", "datePublished") ?? html.match(/"publishDate":"([^"]+)"/)?.[1] ?? null;
  const t = published ? Date.parse(published) : NaN;
  const seconds = html.match(/"lengthSeconds":"(\d+)"/)?.[1];
  const duration_ms = isoDurationMs(meta("itemprop", "duration")) ?? (seconds ? Number(seconds) * 1000 : null);
  const thumb = html.match(/<link itemprop="thumbnailUrl" href="([^"]+)"/)?.[1] ?? meta("property", "og:image");
  const channel_name = html.match(/"ownerChannelName":"([^"]*)"/)?.[1]?.replace(/\\u0026/g, "&") ?? null;
  return {
    video_id: videoId,
    channel_id,
    channel_name: channel_name || null,
    title,
    description: meta("property", "og:description"),
    published_at: Number.isFinite(t) ? t : null,
    duration_ms,
    thumbnail_url: thumb ? decodeEntities(thumb) : null,
    link: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

/** `PT1H2M3S` as milliseconds, or null. */
export function isoDurationMs(value: string | null): number | null {
  const m = value?.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) return null;
  return (Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 1000;
}

function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'" })[e as string]!);
}

/** Whether a URL names a YouTube channel (by id, handle, or custom name), and the page to read its id from. */
export function youtubeChannelPage(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\.|^m\./, "");
  if (host !== "youtube.com") return null;
  const m = u.pathname.match(/^\/(?:(channel\/UC[A-Za-z0-9_-]{22})|(@[^/?]+)|(c\/[^/?]+)|(user\/[^/?]+))/);
  return m ? `https://www.youtube.com/${m[1] ?? m[2] ?? m[3] ?? m[4]}` : null;
}

function str(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  if (v && typeof v === "object") return str((v as Record<string, unknown>)["#text"]);
  return null;
}

function alternate(links: unknown): string | null {
  for (const l of (links as Record<string, unknown>[] | undefined) ?? []) {
    if (l && typeof l === "object" && l["@_rel"] === "alternate" && typeof l["@_href"] === "string") return l["@_href"];
  }
  return null;
}
