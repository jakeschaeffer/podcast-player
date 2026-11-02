/**
 * `/e/{token}`: every shared snip from one episode on one page, in episode order. Server-rendered HTML that works
 * without script (each snip falls back to a native audio element, or its video, and links to its own page). With script, a
 * Spotify-style player docks at the bottom: it plays one snip at a time, moves on to the next when a clip ends,
 * and has previous / play-pause / next, a scrubber, and speed, mirrored on the lock screen through Media Session.
 * Each snip can be shared on its own from its row; the page as a whole from the header.
 */
import type { PublicEpisode } from "../../services/episodeShares.js";
import { escapeHtml, imageMeta, type PageImage, quoteHtml, summaryHtml, transcriptHtml, videoHtml } from "./page.js";

type Ready = Extract<PublicEpisode, { kind: "ready" }>;

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}
function listening(ms: number): string {
  const min = Math.round(ms / 60000);
  return min < 1 ? `${Math.round(ms / 1000)} s` : `${min} min`;
}

const ICON = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="4.5" width="4" height="15" rx="1.2" fill="currentColor"/><rect x="14" y="4.5" width="4" height="15" rx="1.2" fill="currentColor"/></svg>',
  prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 5v14L8 12z" fill="currentColor"/><rect x="5" y="5" width="2.6" height="14" rx="1" fill="currentColor"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5v14l10-7z" fill="currentColor"/><rect x="16.4" y="5" width="2.6" height="14" rx="1" fill="currentColor"/></svg>',
  share: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5"/><path d="M5 12v6.5A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V12"/></svg>',
};

const STYLE = `
:root{color-scheme:light dark;--bg:#faf9f6;--fg:#1a1a1a;--muted:#62605b;--line:#e4e1da;--accent:#c2410c;--on-accent:#fff;--card:#fff;--bar:#fff;--chip:#efece6}
@media (prefers-color-scheme:dark){:root{--bg:#0e0f11;--fg:#f0eee9;--muted:#a9a7a1;--line:#2a2c31;--accent:#f5a524;--on-accent:#141414;--card:#17181c;--bar:#1b1c21;--chip:#26282e}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-tap-highlight-color:transparent}
main{max-width:720px;margin:0 auto;padding:calc(env(safe-area-inset-top) + 28px) calc(env(safe-area-inset-right) + 16px) calc(env(safe-area-inset-bottom) + 48px) calc(env(safe-area-inset-left) + 16px)}
body.has-player main{padding-bottom:calc(env(safe-area-inset-bottom) + 170px)}
a{color:inherit}button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer;touch-action:manipulation}
svg{width:100%;height:100%;display:block}
html:not(.js) .js-only{display:none!important}
.eyebrow{margin:0 0 6px;color:var(--muted);font-size:.95rem}
h1{font-size:1.65rem;line-height:1.2;margin:0 0 6px;letter-spacing:-.01em}
.meta{color:var(--muted);font-size:.95rem;margin:0}
.actions{display:flex;gap:10px;margin:18px 0 8px;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;gap:8px;min-height:48px;padding:0 20px;border-radius:24px;background:var(--chip);font-weight:650}
.btn svg{width:18px;height:18px}
.btn--accent{background:var(--accent);color:var(--on-accent)}
.list{list-style:none;margin:18px 0 0;padding:0}
.snip{display:flex;gap:14px;align-items:flex-start;padding:16px 0;border-top:1px solid var(--line)}
.snip:first-child{border-top:0}
.snip__play{flex:none;width:48px;height:48px;border-radius:24px;background:var(--chip);display:flex;align-items:center;justify-content:center;margin-top:2px}
.snip__play svg{width:20px;height:20px}
.snip.is-current .snip__play{background:var(--accent);color:var(--on-accent)}
.snip__body{flex:1;min-width:0}
.snip__at{margin:0 0 2px;color:var(--muted);font-size:.88rem;font-variant-numeric:tabular-nums}
.snip.is-current .snip__at{color:var(--accent);font-weight:600}
.snip__title{font-size:1.1rem;line-height:1.3;margin:0;overflow-wrap:anywhere}
.snip__title a{text-decoration:none}.snip__title a:hover{text-decoration:underline}
.snip__summary{margin:6px 0 0;color:var(--muted);font-size:.98rem}ul.snip__summary{padding-left:1.2em}ul.snip__summary li{margin:0 0 4px}
.snip__quote{margin:8px 0 0;font-size:1.05rem;font-weight:600;line-height:1.4}
.turn{margin:0 0 12px;white-space:normal}.turn:last-child{margin:0}.who{display:block;font-size:.78rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin:0 0 2px}
.turn--2 .who{color:var(--accent)}
.snip__excerpt{margin-top:8px}.snip__excerpt summary{cursor:pointer;color:var(--muted);font-size:.9rem;font-weight:600;padding:4px 0}
.snip__excerpt blockquote{margin:6px 0 0;padding:12px 14px;background:var(--card);border-left:3px solid var(--accent);border-radius:6px;font-size:.98rem;white-space:pre-wrap}
.snip audio{width:100%;margin-top:10px}
.snip{flex-wrap:wrap}.snip__body{flex:1 1 0}.snip video{display:block;flex:0 0 100%;width:100%;height:auto;background:#000;border-radius:8px;scroll-margin:16px 0 140px}
.snip__share{flex:none;width:44px;height:44px;border-radius:22px;display:flex;align-items:center;justify-content:center;color:var(--muted)}
.snip__share svg{width:20px;height:20px}
.empty{color:var(--muted);padding:24px 0}
footer{margin-top:28px;color:var(--muted);font-size:.88rem}footer a{color:var(--accent)}
.player{position:fixed;left:0;right:0;bottom:0;z-index:10;background:var(--bar);border-top:1px solid var(--line);box-shadow:0 -8px 24px rgba(0,0,0,.08);padding:8px calc(env(safe-area-inset-right) + 14px) calc(env(safe-area-inset-bottom) + 10px) calc(env(safe-area-inset-left) + 14px)}
.player[hidden]{display:none}
.player__in{max-width:720px;margin:0 auto}
.player__row{display:flex;align-items:center;gap:10px}
.player__info{flex:1;min-width:0;text-align:left;display:flex;flex-direction:column;padding:4px 0}
.player__title{font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.player__sub{color:var(--muted);font-size:.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.player__ctl{display:flex;align-items:center;gap:4px;flex:none}
.player__ctl button{width:44px;height:44px;display:flex;align-items:center;justify-content:center;border-radius:22px}
.player__ctl button svg{width:22px;height:22px}
.player__ctl button[disabled]{opacity:.35;cursor:default}
.player__ctl .player__play{width:52px;height:52px;border-radius:26px;background:var(--fg);color:var(--bg)}
.player__ctl .player__play svg{width:24px;height:24px}
.player__scrub{display:flex;align-items:center;gap:10px;margin-top:4px;font-size:.82rem;color:var(--muted);font-variant-numeric:tabular-nums}
.player__scrub span{min-width:38px}.player__scrub span:last-of-type{text-align:right}
.player__seek{flex:1;-webkit-appearance:none;appearance:none;height:28px;background:transparent;margin:0;--p:0%}
.player__seek::-webkit-slider-runnable-track{height:5px;border-radius:3px;background:linear-gradient(to right,var(--accent) var(--p),var(--line) var(--p))}
.player__seek::-moz-range-track{height:5px;border-radius:3px;background:linear-gradient(to right,var(--accent) var(--p),var(--line) var(--p))}
.player__seek::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:8px;background:var(--fg);margin-top:-5.5px}
.player__seek::-moz-range-thumb{width:16px;height:16px;border-radius:8px;background:var(--fg);border:0}
.player__speed{min-width:44px;height:32px;border-radius:16px;background:var(--chip);font-weight:700;font-size:.85rem;color:var(--fg)}
.toast{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(env(safe-area-inset-bottom) + 24px);background:var(--fg);color:var(--bg);padding:10px 16px;border-radius:20px;font-weight:600;font-size:.95rem;z-index:20;opacity:0;transition:opacity .2s;pointer-events:none}
body.has-player .toast{bottom:calc(env(safe-area-inset-bottom) + 132px)}
.toast.on{opacity:1}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;

/** The client side of the page: one audio element and each row's video, the bottom player, sharing, Media Session. No framework. */
const SCRIPT = `
(function () {
  var data = JSON.parse(document.getElementById("snip-data").textContent);
  var items = data.snips;
  if (!items.length) return;
  var $ = function (id) { return document.getElementById(id); };
  var audio = new Audio();
  audio.preload = "metadata";
  var media = audio; // whichever is playing the current clip: the audio element, or that row's video
  var cur = -1, speeds = [1, 1.25, 1.5, 2], speedIdx = 0, seeking = false;
  var rows = Array.prototype.slice.call(document.querySelectorAll(".snip"));
  var bar = $("player"), seek = $("p-seek");
  var ICON_PLAY = ${JSON.stringify(ICON.play)}, ICON_PAUSE = ${JSON.stringify(ICON.pause)};

  function clock(s) {
    s = Math.max(0, Math.round(s || 0));
    var m = Math.floor(s / 60), r = s % 60;
    return m + ":" + (r < 10 ? "0" : "") + r;
  }
  function adopt(i) {
    var el = rows[i].querySelector("video") || audio;
    if (media !== el) media.pause();
    cur = i;
    media = el;
    media.playbackRate = speeds[speedIdx];
    bar.hidden = false;
    document.body.classList.add("has-player");
    meta();
    render();
  }
  function load(i, autoplay) {
    if (i < 0 || i >= items.length) return;
    adopt(i);
    if (media === audio) audio.src = items[i].clip;
    else {
      if (media.currentTime) media.currentTime = 0;
      media.scrollIntoView({ block: "nearest", behavior: "smooth" }); // the picture is the point: keep it in view as clips move on
    }
    if (autoplay !== false) media.play().catch(function () { render(); });
  }
  function toggle(i) {
    if (i === cur) { if (media.paused) media.play(); else media.pause(); }
    else load(i);
  }
  function prev() {
    if (media.currentTime > 3 || cur <= 0) { media.currentTime = 0; if (media.paused) media.play(); }
    else load(cur - 1);
  }
  function next() { if (cur < items.length - 1) load(cur + 1); }
  function render() {
    var playing = cur >= 0 && !media.paused;
    rows.forEach(function (row, i) {
      var on = i === cur;
      row.classList.toggle("is-current", on);
      var b = row.querySelector(".snip__play");
      b.setAttribute("aria-pressed", on && playing ? "true" : "false");
      b.setAttribute("aria-label", (on && playing ? "Pause " : "Play ") + items[i].title);
      b.innerHTML = on && playing ? ICON_PAUSE : ICON_PLAY;
    });
    if (cur < 0) return;
    var it = items[cur];
    $("p-title").textContent = it.title;
    $("p-sub").textContent = (cur + 1) + " of " + items.length + (data.show ? " \\u00b7 " + data.show : "");
    var pb = $("p-play");
    pb.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
    pb.setAttribute("aria-label", playing ? "Pause" : "Play");
    $("p-prev").disabled = false;
    $("p-next").disabled = cur >= items.length - 1;
    time();
  }
  function time() {
    var d = isFinite(media.duration) && media.duration > 0 ? media.duration : items[cur].duration_ms / 1000;
    var t = media.currentTime || 0;
    if (!seeking) { seek.max = String(Math.round(d * 10)); seek.value = String(Math.round(t * 10)); }
    seek.style.setProperty("--p", (d > 0 ? (Number(seek.value) / 10 / d) * 100 : 0) + "%");
    $("p-now").textContent = clock(seeking ? Number(seek.value) / 10 : t);
    $("p-left").textContent = "-" + clock(d - (seeking ? Number(seek.value) / 10 : t));
    if ("mediaSession" in navigator && navigator.mediaSession.setPositionState && isFinite(media.duration) && media.duration > 0) {
      try { navigator.mediaSession.setPositionState({ duration: media.duration, position: Math.min(t, media.duration), playbackRate: media.playbackRate }); } catch (e) {}
    }
  }
  function meta() {
    if (!("mediaSession" in navigator) || typeof MediaMetadata === "undefined") return;
    navigator.mediaSession.metadata = new MediaMetadata({ title: items[cur].title, artist: data.show || "", album: data.episode });
  }
  if ("mediaSession" in navigator) {
    var ms = navigator.mediaSession, set = function (a, f) { try { ms.setActionHandler(a, f); } catch (e) {} };
    set("play", function () { media.play(); });
    set("pause", function () { media.pause(); });
    set("previoustrack", prev);
    set("nexttrack", next);
    set("seekto", function (d) { if (d.seekTime != null) media.currentTime = d.seekTime; });
    set("seekbackward", function (d) { media.currentTime = Math.max(0, media.currentTime - (d.seekOffset || 10)); });
    set("seekforward", function (d) { media.currentTime = Math.min(media.duration || 0, media.currentTime + (d.seekOffset || 10)); });
  }

  [audio].concat(rows.map(function (row) { return row.querySelector("video"); }).filter(Boolean)).forEach(function (el) {
    el.addEventListener("play", function () {
      // A row's own video controls start it directly; the page follows.
      var i = rows.findIndex(function (row) { return row.querySelector("video") === el; });
      if (i >= 0 && i !== cur) adopt(i); else render();
    });
    el.addEventListener("pause", render);
    el.addEventListener("timeupdate", time);
    el.addEventListener("loadedmetadata", time);
    el.addEventListener("ended", function () { if (cur < items.length - 1) load(cur + 1); else render(); });
  });

  rows.forEach(function (row, i) { row.querySelector(".snip__play").addEventListener("click", function () { toggle(i); }); });
  $("play-all").addEventListener("click", function () { if (cur < 0) load(0); else toggle(cur); });
  $("p-play").addEventListener("click", function () { toggle(cur); });
  $("p-prev").addEventListener("click", prev);
  $("p-next").addEventListener("click", next);
  $("p-info").addEventListener("click", function () { rows[cur].scrollIntoView({ block: "center", behavior: "smooth" }); });
  $("p-speed").addEventListener("click", function () {
    speedIdx = (speedIdx + 1) % speeds.length;
    media.playbackRate = speeds[speedIdx];
    this.textContent = speeds[speedIdx] + "\\u00d7";
    this.setAttribute("aria-label", "Playback speed, " + speeds[speedIdx] + " times");
  });
  seek.addEventListener("input", function () { seeking = true; time(); });
  seek.addEventListener("change", function () { media.currentTime = Number(seek.value) / 10; seeking = false; time(); });

  var toastTimer;
  function toast(msg) {
    var t = $("toast");
    t.textContent = msg;
    t.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("on"); }, 1800);
  }
  function copy(url) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(url).then(function () { toast("Link copied"); }, function () { fallback(url); });
    fallback(url);
  }
  function fallback(url) {
    var ta = document.createElement("textarea");
    ta.value = url; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(ta);
    if (ok) toast("Link copied"); else window.prompt("Copy this link", url);
  }
  function share(path, title) {
    var url = new URL(path, location.href).href;
    if (navigator.share) {
      navigator.share({ title: title, url: url }).catch(function (e) { if (!e || e.name !== "AbortError") copy(url); });
    } else copy(url);
  }
  Array.prototype.forEach.call(document.querySelectorAll("[data-share]"), function (b) {
    b.addEventListener("click", function () { share(b.getAttribute("data-share"), b.getAttribute("data-title")); });
  });
})();
`;

/** "10 clips from Stratechery": the description a pasted link shows under the title. */
export function clipCount(n: number, show: string | null): string {
  const what = n === 0 ? "Clips" : n === 1 ? "1 clip" : `${n} clips`;
  return show ? `${what} from ${show}` : what;
}

export function renderEpisodePage(view: Ready, pageUrl: string, nonce: string, image: PageImage | null = null): string {
  const episode = escapeHtml(view.episode.title);
  const show = view.show.title ? escapeHtml(view.show.title) : null;
  const n = view.snips.length;
  const total = view.snips.reduce((sum, s) => sum + s.duration_ms, 0);
  const countLine = n === 0 ? "No clips shared yet" : `${n} clip${n === 1 ? "" : "s"} · ${listening(total)} of listening`;
  const pageTitle = `Clips from ${view.episode.title}`;
  const desc = clipCount(n, view.show.title);
  // Data for the script; "<" is escaped so no title can close the script element.
  const json = JSON.stringify({
    episode: view.episode.title, show: view.show.title,
    snips: view.snips.map((s) => ({ title: s.title, clip: s.clip_path, duration_ms: s.duration_ms })),
  }).replace(/</g, "\\u003c");
  const rows = view.snips
    .map((s) => {
      const title = escapeHtml(s.title);
      return `<li class="snip" id="snip-${escapeHtml(s.token)}">
${s.video ? videoHtml({ url: s.video.path, poster: s.video.poster_path, width: s.video.width, height: s.video.height }, "none", s.title) : ""}
<button class="snip__play js-only" type="button" aria-pressed="false" aria-label="Play ${title}">${ICON.play}</button>
<div class="snip__body">
<p class="snip__at">${clock(s.duration_ms)} clip · from ${clock(s.start_ms)}</p>
<h2 class="snip__title"><a href="${escapeHtml(s.page_path)}">${title}</a></h2>
${quoteHtml(s.quote, "snip__quote")}
${summaryHtml(s.summary, "snip__summary")}
${s.excerpt ? `<details class="snip__excerpt"><summary>Transcript</summary>${transcriptHtml(s.excerpt, s.turns)}</details>` : ""}
${s.video ? "" : `<noscript><audio controls preload="none" src="${escapeHtml(s.clip_path)}"></audio></noscript>`}
</div>
<button class="snip__share js-only" type="button" data-share="${escapeHtml(s.page_path)}" data-title="${title}" aria-label="Share ${title}">${ICON.share}</button>
</li>`;
    })
    .join("\n");
  const episodeLink = view.episode.public_url ? `<a href="${escapeHtml(view.episode.public_url)}" rel="noopener nofollow">Episode page</a>` : "";
  const showLink = view.show.site_url ? `<a href="${escapeHtml(view.show.site_url)}" rel="noopener nofollow">${show ?? "Show"}</a>` : "";
  const firstClip = view.snips[0] ? new URL(view.snips[0].clip_path, pageUrl).href : null;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(pageTitle)}</title>
<meta property="og:type" content="website">
<meta property="og:title" content="${escapeHtml(pageTitle)}">
<meta property="og:description" content="${escapeHtml(desc)}">
<meta property="og:url" content="${escapeHtml(pageUrl)}">
<meta name="description" content="${escapeHtml(desc)}">
${imageMeta(image)}
${firstClip ? `<meta property="og:audio" content="${escapeHtml(firstClip)}">\n<meta property="og:audio:type" content="audio/mpeg">` : ""}
<script nonce="${nonce}">document.documentElement.classList.add("js")</script>
<style>${STYLE}</style>
</head>
<body>
<main>
<header>
${show ? `<p class="eyebrow">${show}</p>` : ""}
<h1>${episode}</h1>
<p class="meta">${countLine}</p>
${n > 0 ? `<div class="actions js-only">
<button class="btn btn--accent" id="play-all" type="button">${ICON.play}Play all</button>
<button class="btn" type="button" data-share="${escapeHtml(new URL(pageUrl).pathname)}" data-title="${escapeHtml(pageTitle)}">${ICON.share}Share</button>
</div>` : ""}
</header>
${n > 0 ? `<ol class="list">\n${rows}\n</ol>` : `<p class="empty">Nothing is shared from this episode right now.</p>`}
<footer>${[episodeLink, showLink].filter(Boolean).join(" · ")}</footer>
</main>
<div class="player js-only" id="player" role="region" aria-label="Player" hidden>
<div class="player__in">
<div class="player__row">
<button class="player__info" id="p-info" type="button" aria-label="Show the playing snip in the list"><span class="player__title" id="p-title"></span><span class="player__sub" id="p-sub"></span></button>
<div class="player__ctl">
<button id="p-prev" type="button" aria-label="Previous clip">${ICON.prev}</button>
<button id="p-play" class="player__play" type="button" aria-label="Play">${ICON.play}</button>
<button id="p-next" type="button" aria-label="Next clip">${ICON.next}</button>
</div>
</div>
<div class="player__scrub">
<span id="p-now">0:00</span>
<input class="player__seek" id="p-seek" type="range" min="0" max="1000" value="0" step="1" aria-label="Seek">
<span id="p-left">-0:00</span>
<button class="player__speed" id="p-speed" type="button" aria-label="Playback speed, 1 times">1×</button>
</div>
</div>
</div>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
<script type="application/json" id="snip-data">${json}</script>
${n > 0 ? `<script nonce="${nonce}">${SCRIPT}</script>` : ""}
</body>
</html>`;
}

export function renderEpisodeGonePage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>These clips are no longer shared</title><style>${STYLE}</style></head>
<body><main><h1>These clips are no longer shared</h1><p class="meta">The person who shared this page has withdrawn it.</p></main></body></html>`;
}
