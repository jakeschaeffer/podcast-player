import { asFeedUrl } from "./feedUrl";

/**
 * What a link pasted into the show search is, so the screen offers the right action before the server sees it
 * (the native app's `YouTubeLink` and `MediaLink` make the same calls):
 * - a YouTube video, in any of the URL forms the web uses, for `POST /v1/youtube/episodes`;
 * - a YouTube channel (by id, handle or custom name; a bare `@handle` counts), subscribed like a feed;
 * - a link to a media file by its extension, for `POST /v1/links/episodes` (a one-off of the Pasted links show);
 * - anything else that is an address, taken for a feed.
 */
export type PastedLink = { kind: "youtube-video" | "youtube-channel" | "media" | "feed"; url: string };

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const MEDIA_EXT = /\.(mp4|m4v|mov|webm|mkv|mp3|m4a|m4b|aac|ogg|oga|opus|wav|flac|wma)$/i;

export function classifyLink(text: string): PastedLink | null {
  const t = text.trim();
  if (t.length === 0 || /\s/.test(t)) return null;
  if (/^@[A-Za-z0-9._-]{3,}$/.test(t)) return { kind: "youtube-channel", url: `https://www.youtube.com/${t}` };
  const withScheme = /^https?:\/\//i.test(t) ? t : `https://${t}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
  if (host === "youtu.be") return video(u.pathname.split("/")[1] ?? null);
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (u.pathname === "/watch") return video(u.searchParams.get("v"));
    const v = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?]+)/);
    if (v) return video(v[1] ?? null);
    const c = u.pathname.match(/^\/(channel\/UC[A-Za-z0-9_-]{22}|@[^/?]+|c\/[^/?]+|user\/[^/?]+)/);
    if (c) return { kind: "youtube-channel", url: `https://www.youtube.com/${c[1]}` };
    return null;
  }
  const feed = asFeedUrl(t);
  if (!feed) return null;
  return { kind: MEDIA_EXT.test(u.pathname) ? "media" : "feed", url: feed };
}

function video(id: string | null): PastedLink | null {
  return id && VIDEO_ID.test(id) ? { kind: "youtube-video", url: `https://www.youtube.com/watch?v=${id}` } : null;
}
