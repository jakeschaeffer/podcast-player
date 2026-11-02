import type { PublicSnip } from "../../services/publicSnips.js";

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const STYLE = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--muted:#666;--accent:#c2410c;--card:#f6f6f6}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--fg:#ececec;--muted:#9a9a9a;--accent:#fb923c;--card:#1e1e1e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:640px;margin:0 auto;padding:32px 16px 64px}h1{font-size:1.5rem;line-height:1.25;margin:0 0 8px}
.meta{color:var(--muted);font-size:.95rem;margin:0 0 20px}audio{width:100%;margin:8px 0 20px}
video{display:block;width:100%;height:auto;max-height:70vh;margin:8px 0 20px;background:#000;border-radius:8px}
.summary{font-size:1.05rem;margin:0 0 24px}ul.summary{padding-left:1.2em}ul.summary li{margin:0 0 6px}
.pull{font-size:1.3rem;line-height:1.4;font-weight:600;margin:0 0 24px}
.turn{margin:0 0 14px;white-space:normal}.turn:last-child{margin:0}.who{display:block;font-size:.8rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin:0 0 2px}
.turn--2 .who{color:var(--accent)}
blockquote{margin:0;padding:16px 18px;background:var(--card);border-left:3px solid var(--accent);border-radius:6px;white-space:pre-wrap}
.word.on{background:color-mix(in srgb,var(--accent) 25%,transparent);border-radius:2px}
footer{margin-top:32px;color:var(--muted);font-size:.85rem}a{color:var(--accent)}
`;

/** The page's preview image (og:image): its absolute URL and a description of it. */
export type PageImage = { url: string; alt: string; width: number; height: number };

/** Open Graph and Twitter tags for a page's preview image, so a pasted link shows it large. */
export function imageMeta(image: PageImage | null): string {
  if (!image) return `<meta name="twitter:card" content="summary">`;
  return [
    `<meta property="og:image" content="${escapeHtml(image.url)}">`,
    `<meta property="og:image:type" content="image/png">`,
    `<meta property="og:image:width" content="${image.width}">`,
    `<meta property="og:image:height" content="${image.height}">`,
    `<meta property="og:image:alt" content="${escapeHtml(image.alt)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
  ].join("\n");
}

/** The summary: bullets, one per line, since snip-summary v3; a paragraph before that. */
export function summaryHtml(summary: string | null, className: string): string {
  if (!summary) return "";
  const lines = summary.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return `<p class="${className}">${escapeHtml(summary)}</p>`;
  return `<ul class="${className}">${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`;
}

/** The pull quote the summary chose, in curly quotes. */
export function quoteHtml(quote: string | null, className: string): string {
  return quote ? `<p class="${className}">“${escapeHtml(quote)}”</p>` : "";
}

/**
 * The excerpt. With more than one speaker, each turn is its own paragraph under its speaker's name (or "Host", "Guest"),
 * and the speakers alternate label colours so a change of voice reads at a glance; otherwise one block.
 */
export function transcriptHtml(excerpt: string | null, turns: { speaker: string | null; name: string; text: string }[] | null): string {
  if (!excerpt) return "";
  if (!turns) return `<blockquote>${escapeHtml(excerpt)}</blockquote>`;
  const order = [...new Set(turns.map((t) => t.speaker))];
  const body = turns
    .map((t) => {
      const n = order.indexOf(t.speaker);
      return `<p class="turn turn--${(n % 2) + 1}"><span class="who">${escapeHtml(t.name)}</span>${escapeHtml(t.text)}</p>`;
    })
    .join("");
  return `<blockquote>${body}</blockquote>`;
}

/**
 * What a pasted link to one clip says under its title: where it is from, then its pull quote (or the start of its
 * summary), e.g. "A clip from Stratechery · “There is an under-investment in diffusion.”".
 */
export function clipDescription(view: Extract<PublicSnip, { kind: "ready" }>): string {
  const from = `A clip from ${view.show.title ?? view.episode.title}`;
  const line = view.quote ? `“${view.quote}”` : (view.summary?.split("\n")[0]?.trim() || null);
  return line ? `${from} · ${line}` : from;
}

/** Open Graph tags for a clip's picture, for the link previews that play video. */
function videoMeta(video: { url: string; width: number; height: number }): string {
  return [
    `<meta property="og:video" content="${escapeHtml(video.url)}">`,
    `<meta property="og:video:secure_url" content="${escapeHtml(video.url)}">`,
    `<meta property="og:video:type" content="video/mp4">`,
    `<meta property="og:video:width" content="${video.width}">`,
    `<meta property="og:video:height" content="${video.height}">`,
  ].join("\n");
}

/** A clip's picture as a native player; `preload` is "none" where a page holds many of them. */
export function videoHtml(video: { url: string; poster: string; width: number; height: number }, preload: "metadata" | "none", label: string): string {
  const size = video.width > 0 && video.height > 0 ? ` width="${video.width}" height="${video.height}"` : "";
  return `<video controls playsinline preload="${preload}" poster="${escapeHtml(video.poster)}" src="${escapeHtml(video.url)}"${size} aria-label="${escapeHtml(label)}"></video>`;
}

/** The recipient page: a native video or audio element, the summary, the exact excerpt, and attribution. No framework, works without script. */
export function renderPublicPage(view: Extract<PublicSnip, { kind: "ready" }>, pageUrl: string, image: PageImage | null = null): string {
  const title = escapeHtml(view.title);
  const desc = escapeHtml(clipDescription(view));
  const show = view.show.title ? escapeHtml(view.show.title) : null;
  const attribution = [show, escapeHtml(view.episode.title)].filter(Boolean).join(" · ");
  const episodeLink = view.episode.public_url ? `<a href="${escapeHtml(view.episode.public_url)}" rel="noopener nofollow">Episode page</a>` : "";
  const showLink = view.show.site_url ? `<a href="${escapeHtml(view.show.site_url)}" rel="noopener nofollow">${show ?? "Show"}</a>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${title}</title>
<meta property="og:type" content="${view.video ? "video.other" : "music.song"}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:url" content="${escapeHtml(pageUrl)}">
<meta name="description" content="${desc}">
${imageMeta(image)}
<meta property="og:audio" content="${escapeHtml(view.clip_url)}">
<meta property="og:audio:type" content="audio/mpeg">
${view.video ? videoMeta(view.video) : ""}
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${title}</h1>
<p class="meta">${attribution} · ${fmtDuration(view.duration_ms)}</p>
${view.video ? videoHtml({ url: view.video.url, poster: view.video.poster_url, width: view.video.width, height: view.video.height }, "metadata", view.title) : `<audio controls preload="metadata" src="${escapeHtml(view.clip_url)}"></audio>`}
${quoteHtml(view.quote, "pull")}
${summaryHtml(view.summary, "summary")}
${transcriptHtml(view.excerpt, view.turns)}
<footer>${[episodeLink, showLink].filter(Boolean).join(" · ")}</footer>
</main>
</body>
</html>`;
}

export function renderPreparingPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<meta http-equiv="refresh" content="5"><title>Preparing this clip…</title><style>${STYLE}</style></head>
<body><main><h1>Preparing this clip…</h1><p class="meta">The recording, transcript, and summary are being prepared. This page refreshes on its own.</p></main></body></html>`;
}

export function renderGonePage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>This clip is no longer available</title><style>${STYLE}</style></head>
<body><main><h1>This clip is no longer available</h1><p class="meta">The person who shared it has withdrawn it.</p></main></body></html>`;
}
