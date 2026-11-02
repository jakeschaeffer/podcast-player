import { XMLParser } from "fast-xml-parser";
import { orderedPoints, parseNpt, type ChapterPoint } from "../chapters/points.js";

export type FeedMeta = {
  title: string | null;
  author: string | null;
  image_url: string | null;
  site_url: string | null;
  language: string | null;
};

export type FeedItem = {
  /** Stable identity: the GUID, else the enclosure URL without a query string, else the link. */
  identity: string;
  identity_source: "guid" | "enclosure" | "link";
  title: string;
  description_html: string | null;
  published_at: number | null;
  enclosure_url: string;
  enclosure_type: string | null;
  enclosure_bytes: number | null;
  /** What the enclosure is: 'video' when the only enclosure is a video. */
  media_kind: "audio" | "video";
  /** A video enclosure beside the audio one (`<enclosure type="video/…">` or `<podcast:alternateEnclosure>`), for Watch video. */
  video_url: string | null;
  duration_hint_ms: number | null;
  image_url: string | null;
  link: string | null;
  /** A Podcasting 2.0 JSON chapters file (`<podcast:chapters url=… type="application/json+chapters">`), fetched later. */
  chapters_url: string | null;
  /** Podlove Simple Chapters inline in the item (`<psc:chapters><psc:chapter start="00:01:02.000" title="…"/>`). */
  chapters: ChapterPoint[] | null;
};

export type ParsedFeed = {
  feed: FeedMeta;
  items: FeedItem[];
  /** Items skipped because they had no enclosure or no usable identity, for the refresh report. */
  skipped: { title: string | null; reason: string }[];
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  cdataPropName: "#cdata",
  processEntities: true,
  htmlEntities: true,
  trimValues: true,
  // No DTD/external entity handling: fast-xml-parser does not resolve external entities, which is what we want.
  isArray: (name) => name === "item" || name === "enclosure" || name === "psc:chapter" || name === "podcast:chapters" || name === "podcast:alternateEnclosure" || name === "podcast:source",
});

/**
 * Parse an RSS 2.0 podcast feed with the iTunes and podcast namespaces. Tolerant of missing fields.
 * Pure: no network, no clock. Throws only when the document is not a feed at all.
 */
export function parseFeed(xml: string): ParsedFeed {
  const doc = parser.parse(xml) as Record<string, unknown>;
  const rss = doc["rss"] as Record<string, unknown> | undefined;
  const channel = (rss?.["channel"] ?? (doc["channel"] as unknown)) as Record<string, unknown> | undefined;
  if (!channel || typeof channel !== "object") throw new Error("not an RSS feed: no <channel>");

  const feed: FeedMeta = {
    title: text(channel["title"]),
    author: text(channel["itunes:author"]) ?? text(channel["managingEditor"]),
    image_url: imageUrl(channel),
    site_url: text(channel["link"]),
    language: text(channel["language"]),
  };

  const items: FeedItem[] = [];
  const skipped: ParsedFeed["skipped"] = [];
  const rawItems = (channel["item"] as unknown[] | undefined) ?? [];
  for (const raw of rawItems) {
    const it = raw as Record<string, unknown>;
    const title = text(it["title"]) ?? "(untitled)";
    const enclosures = (it["enclosure"] as Record<string, unknown>[] | undefined) ?? [];
    const enc = enclosures.find((e) => typeof e["@_url"] === "string" && String(e["@_type"] ?? "").startsWith("audio/")) ?? enclosures.find((e) => typeof e["@_url"] === "string");
    if (!enc) {
      skipped.push({ title, reason: "no enclosure" });
      continue;
    }
    const enclosure_url = String(enc["@_url"]).trim();
    const isVideo = (e: Record<string, unknown>) => String(e["@_type"] ?? "").startsWith("video/");
    const videoEnc = enc !== undefined && !isVideo(enc) ? (enclosures.find((e) => typeof e["@_url"] === "string" && isVideo(e)) ?? alternateVideo(it)) : null;
    const link = text(it["link"]);
    const guid = text(it["guid"]);
    let identity: string;
    let identity_source: FeedItem["identity_source"];
    if (guid) {
      identity = guid;
      identity_source = "guid";
    } else if (enclosure_url) {
      identity = enclosure_url.split("?")[0]!;
      identity_source = "enclosure";
    } else if (link) {
      identity = link;
      identity_source = "link";
    } else {
      skipped.push({ title, reason: "no identity" });
      continue;
    }
    const bytes = Number(enc["@_length"]);
    items.push({
      identity,
      identity_source,
      title,
      description_html: html(it["content:encoded"]) ?? html(it["description"]) ?? html(it["itunes:summary"]),
      published_at: date(text(it["pubDate"])),
      enclosure_url,
      enclosure_type: typeof enc["@_type"] === "string" ? enc["@_type"] : null,
      enclosure_bytes: Number.isFinite(bytes) && bytes > 0 ? bytes : null,
      media_kind: isVideo(enc) ? "video" : "audio",
      video_url: videoEnc && typeof videoEnc["@_url"] === "string" ? String(videoEnc["@_url"]).trim() : null,
      duration_hint_ms: duration(text(it["itunes:duration"])),
      image_url: imageUrl(it),
      link,
      chapters_url: chaptersUrl(it),
      chapters: pscChapters(it),
    });
  }
  return { feed, items, skipped };
}

function text(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return text(o["#cdata"]) ?? text(o["#text"]) ?? null;
  }
  return null;
}

function html(v: unknown): string | null {
  return text(v);
}

/** A Podcasting 2.0 `<podcast:alternateEnclosure type="video/…">` with a `<podcast:source uri=…>` inside, if any. */
function alternateVideo(item: Record<string, unknown>): Record<string, unknown> | null {
  const alts = item["podcast:alternateEnclosure"];
  for (const raw of Array.isArray(alts) ? alts : alts ? [alts] : []) {
    if (!raw || typeof raw !== "object") continue;
    const alt = raw as Record<string, unknown>;
    if (!String(alt["@_type"] ?? "").startsWith("video/")) continue;
    const sources = alt["podcast:source"];
    const first = (Array.isArray(sources) ? sources[0] : sources) as Record<string, unknown> | undefined;
    const uri = first && typeof first === "object" && typeof first["@_uri"] === "string" ? first["@_uri"] : null;
    if (uri && /^https?:\/\//i.test(uri)) return { "@_url": uri, "@_type": alt["@_type"] };
  }
  return null;
}

/** The item's JSON chapters URL; a tag of another type (a few feeds point at an HTML page) is ignored. */
function chaptersUrl(item: Record<string, unknown>): string | null {
  const tags = (item["podcast:chapters"] as unknown[] | undefined) ?? [];
  for (const raw of tags) {
    if (!raw || typeof raw !== "object") continue;
    const tag = raw as Record<string, unknown>;
    const url = typeof tag["@_url"] === "string" ? tag["@_url"].trim() : "";
    const type = typeof tag["@_type"] === "string" ? tag["@_type"].toLowerCase() : "";
    if (/^https?:\/\//i.test(url) && (type === "" || type.includes("json"))) return url;
  }
  return null;
}

/** Podlove Simple Chapters: `start` in normal play time, `title` required. Null when fewer than two survive. */
function pscChapters(item: Record<string, unknown>): ChapterPoint[] | null {
  const container = item["psc:chapters"];
  if (!container || typeof container !== "object") return null;
  const list = ((container as Record<string, unknown>)["psc:chapter"] as unknown[] | undefined) ?? [];
  const points: ChapterPoint[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    const start = typeof c["@_start"] === "string" ? parseNpt(c["@_start"]) : null;
    const title = typeof c["@_title"] === "string" ? c["@_title"] : null;
    if (start !== null && title) points.push({ start_ms: start, title });
  }
  return orderedPoints(points);
}

function imageUrl(node: Record<string, unknown>): string | null {
  const itunes = node["itunes:image"] as Record<string, unknown> | string | undefined;
  if (itunes && typeof itunes === "object" && typeof itunes["@_href"] === "string") return itunes["@_href"];
  const image = node["image"] as Record<string, unknown> | undefined;
  if (image && typeof image === "object") return text(image["url"]);
  return null;
}

function date(v: string | null | undefined): number | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** `HH:MM:SS`, `MM:SS`, or plain seconds, as iTunes allows. */
export function duration(v: string | null): number | null {
  if (!v) return null;
  const parts = v.split(":").map((p) => Number(p));
  if (parts.some((p) => !Number.isFinite(p) || p < 0)) return null;
  let seconds = 0;
  for (const p of parts) seconds = seconds * 60 + p;
  return seconds > 0 ? Math.round(seconds * 1000) : null;
}


export type TextItem = {
  identity: string;
  title: string;
  published_at: number | null;
  /** Full item HTML (`content:encoded`, else `description`). */
  html: string;
  link: string | null;
};

/** Items of a text (article) feed: everything with a title and some HTML, enclosure or not. */
export function parseTextFeed(xml: string): { feed: FeedMeta; items: TextItem[] } {
  const doc = parser.parse(xml) as Record<string, unknown>;
  const rss = doc["rss"] as Record<string, unknown> | undefined;
  const channel = (rss?.["channel"] ?? (doc["channel"] as unknown)) as Record<string, unknown> | undefined;
  if (!channel || typeof channel !== "object") throw new Error("not an RSS feed: no <channel>");
  const feed: FeedMeta = {
    title: text(channel["title"]),
    author: text(channel["itunes:author"]) ?? text(channel["managingEditor"]),
    image_url: imageUrl(channel),
    site_url: text(channel["link"]),
    language: text(channel["language"]),
  };
  const items: TextItem[] = [];
  for (const raw of (channel["item"] as unknown[] | undefined) ?? []) {
    const it = raw as Record<string, unknown>;
    const title = text(it["title"]);
    const html = text(it["content:encoded"]) ?? text(it["description"]);
    if (!title || !html) continue;
    const guid = text(it["guid"]);
    const link = text(it["link"]);
    const identity = guid ?? link ?? title;
    items.push({ identity, title, published_at: date(text(it["pubDate"])), html, link });
  }
  return { feed, items };
}
