/**
 * The preview image of a public page (og:image), what a link shows when it is pasted into Slack or a message: the
 * show's artwork beside the page's title and who shared it ("10 clips from Jake"). 1200 × 630, laid out with satori
 * and drawn with resvg. Each image is kept in data/og/ under a hash of what it shows, so a page is drawn once per
 * change, and the page links it with that hash so a changed image is a new URL.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import satori from "satori";
import type { AppContext } from "../app/context.js";
import type { FeedRow, SnipRow } from "../db/rows.js";
import { safeFetch } from "../lib/safeFetch.js";
import { getEpisodeRow } from "./episodes.js";
import { publicEpisode } from "./episodeShares.js";
import { publicSnip } from "./publicSnips.js";
import { episodeForAsset } from "./snips.js";

export const SHARE_IMAGE = { width: 1200, height: 630 };
/** Bump when the layout changes, so every page links a freshly drawn image. */
const DESIGN = "2";
const ARTWORK_MAX_BYTES = 10 * 1024 * 1024;

/** What one preview image shows. */
export type ShareCard = { eyebrow: string | null; title: string; byline: string; artworkUrl: string | null };

/** The card for `/e/{token}`: the episode's title and how many clips it has. Null unless the page is up. */
export function episodeShareCard(ctx: AppContext, token: string): ShareCard | null {
  const view = publicEpisode(ctx, token);
  if (view.kind !== "ready") return null;
  const row = ctx.db.prepare("SELECT episode_id FROM episode_share WHERE share_token = ?").get(token) as { episode_id: string };
  const episode = getEpisodeRow(ctx, row.episode_id);
  const feed = ctx.db.prepare("SELECT * FROM feed WHERE id = ?").get(episode.feed_id) as FeedRow;
  return {
    eyebrow: view.show.title,
    title: view.episode.title,
    byline: clipsBy(view.snips.length, ctx.config.shareByName),
    artworkUrl: feed.image_url ?? episode.image_url,
  };
}

/** The card for `/s/{token}`: the snip's title. Null unless the page is up. */
export function snipShareCard(ctx: AppContext, token: string): ShareCard | null {
  const view = publicSnip(ctx, token);
  if (view.kind !== "ready") return null;
  const snip = ctx.db.prepare("SELECT * FROM snip WHERE share_token = ?").get(token) as SnipRow;
  const { episode, feed } = episodeForAsset(ctx, snip.audio_asset_id);
  return { eyebrow: view.show.title, title: view.title, byline: clipsBy(1, ctx.config.shareByName), artworkUrl: feed.image_url ?? episode.image_url };
}

/** "10 clips from Jake", "A clip from Jake"; without a name, "10 clips". */
export function clipsBy(n: number, name: string): string {
  const what = n === 0 ? "Clips" : n === 1 ? "A clip" : `${n} clips`;
  return name.trim() ? `${what} from ${name.trim()}` : what;
}

/** Changes whenever the image would: the page puts it in the image's URL. */
export function cardVersion(card: ShareCard): string {
  return createHash("sha256").update(JSON.stringify([DESIGN, card])).digest("hex").slice(0, 16);
}

const inFlight = new Map<string, Promise<Buffer>>();

/** The card's PNG, drawn the first time and read from data/og/ after that. */
export function shareImage(ctx: AppContext, card: ShareCard): Promise<Buffer> {
  const version = cardVersion(card);
  const dir = join(ctx.config.dataDir, "og");
  const path = join(dir, `${version}.png`);
  if (existsSync(path)) return Promise.resolve(readFileSync(path));
  const running = inFlight.get(version);
  if (running) return running;
  const work = (async () => {
    const artwork = card.artworkUrl ? await fetchArtwork(ctx, card.artworkUrl) : null;
    const png = await renderShareCard(card, artwork);
    // An image drawn without artwork that should have had it is not kept, so the next request tries again.
    if (!card.artworkUrl || artwork) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${path}.tmp`, png);
      renameSync(`${path}.tmp`, path);
    }
    return png;
  })().finally(() => inFlight.delete(version));
  inFlight.set(version, work);
  return work;
}

export type Artwork = { mime: "image/png" | "image/jpeg"; data: Buffer };

/** The show's artwork, when it can be fetched and is a PNG or JPEG (all resvg draws); otherwise null. */
async function fetchArtwork(ctx: AppContext, url: string): Promise<Artwork | null> {
  try {
    // Image CDNs that pick a format by the Accept header (format=auto) are asked for one resvg can draw.
    const res = await safeFetch(url, {
      headers: { accept: "image/png,image/jpeg;q=0.9" },
      maxBytes: ARTWORK_MAX_BYTES,
      timeoutMs: 10_000,
      allowPrivateNetwork: ctx.config.allowPrivateNetwork,
    });
    if (res.status !== 200 || !res.body) {
      await res.body?.cancel();
      return null;
    }
    const data = Buffer.from(await new Response(res.body).arrayBuffer());
    if (data.length > ARTWORK_MAX_BYTES) return null;
    return artworkOf(data);
  } catch (err) {
    ctx.log("share image artwork failed", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Recognises PNG and JPEG by their first bytes; anything else (WebP, GIF) is drawn without artwork. */
export function artworkOf(data: Buffer): Artwork | null {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: "image/png", data };
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { mime: "image/jpeg", data };
  return null;
}

const require = createRequire(import.meta.url);
let fonts: { name: string; data: Buffer; weight: 600 | 700; style: "normal" }[] | null = null;
function loadFonts() {
  fonts ??= ([600, 700] as const).map((weight) => ({
    name: "Inter",
    data: readFileSync(require.resolve(`@fontsource/inter/files/inter-latin-${weight}-normal.woff`)),
    weight,
    style: "normal" as const,
  }));
  return fonts;
}

/** Large type that still fits a long episode title: the longer the title, the smaller, and at most a few lines. */
function titleType(title: string, wide: boolean): { size: number; lines: number } {
  const n = title.length;
  if (n <= 40) return { size: wide ? 72 : 64, lines: 4 };
  if (n <= 80) return { size: wide ? 62 : 54, lines: 5 };
  return { size: wide ? 54 : 46, lines: 6 };
}

const MARGIN = 72;

type Node = { type: string; props: Record<string, unknown> };
const el = (type: string, style: Record<string, unknown>, children?: unknown, extra: Record<string, unknown> = {}): Node => ({
  type,
  props: { style, ...(children === undefined ? {} : { children }), ...extra },
});

/** Draws the card: artwork on the left when there is any, then the show, the title and the byline, light on dark. */
export async function renderShareCard(card: ShareCard, artwork: Artwork | null): Promise<Buffer> {
  const { width, height } = SHARE_IMAGE;
  const art = height - 2 * MARGIN;
  const type = titleType(card.title, !artwork);
  const text = el("div", { display: "flex", flexDirection: "column", justifyContent: "center", flex: 1, minWidth: 0, gap: 22 }, [
    ...(card.eyebrow ? [el("div", { fontSize: 32, fontWeight: 600, color: "#a3a3a3", lineClamp: 1 }, card.eyebrow)] : []),
    el("div", { fontSize: type.size, fontWeight: 700, color: "#f5f5f5", lineHeight: 1.12, letterSpacing: -1, lineClamp: type.lines }, card.title),
    el("div", { fontSize: 36, fontWeight: 600, color: "#fb923c" }, card.byline),
  ]);
  // The content box is sized outright (the frame less a 72 px margin) rather than padded, which satori adds outside.
  const root = el("div", { width, height, display: "flex", alignItems: "center", justifyContent: "center", background: "#141414", fontFamily: "Inter" }, [
    el("div", { width: width - 2 * MARGIN, height: height - 2 * MARGIN, display: "flex", alignItems: "center", gap: 64 }, [
      ...(artwork
        ? [el("img", { width: art, height: art, borderRadius: 28, objectFit: "cover", flexShrink: 0 }, undefined, { src: `data:${artwork.mime};base64,${artwork.data.toString("base64")}`, width: art, height: art })]
        : []),
      text,
    ]),
  ]);
  const svg = await satori(root as Parameters<typeof satori>[0], { width, height, fonts: loadFonts() });
  return new Resvg(svg, { fitTo: { mode: "width", value: width }, font: { loadSystemFonts: false } }).render().asPng();
}
