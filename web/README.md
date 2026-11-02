# web

The mobile-first web client: Today, Library, a full player with chapters and a following transcript, one-tap snips with a result card and boundary editor, and the Snips list. React + TypeScript + Vite, installable as a Home Screen app. The design follows the Night Shift direction at the larger-text scale (DM Sans, near-black ground, amber accent, 48–60 px controls); a light theme follows the system or the Settings choice.

## Run

Requirements: Node 22, pnpm, and the server running on `127.0.0.1:8080` (`pnpm --dir server dev`).

```bash
pnpm install
pnpm --dir web dev            # http://127.0.0.1:5173, proxies /v1, /m, /s to the server
pnpm --dir web dev --host <tailscale ip>   # for a phone on the tailnet: http://<machine>.<tailnet>.ts.net:5173 (hosts under .ts.net are allowed; binding to the Tailscale IP keeps it off the public interface)
pnpm --dir web typecheck
pnpm --dir web test           # the pure player and editor rules against contracts/golden
pnpm --dir web build          # dist/, static files to serve next to the API
pnpm --dir web gen:api        # regenerate src/api/schema.d.ts from the committed ../server/openapi.json
```

For HTTPS on the tailnet (a secure context, so the clipboard works on the phone): `tailscale serve --bg http://<tailscale ip>:5173`, then open `https://<machine>.<tailnet>.ts.net/`. Requests from the machine to its own Tailscale address bypass serve, so check it from another device.

`API_URL` changes where the dev proxy points (default `http://127.0.0.1:8080`). The generated `src/api/schema.d.ts` is committed so the type check works without a running server; regenerate it whenever the server's routes change (`pnpm --dir server openapi:update`, then `gen:api`).

Sign in with the owner password (`OWNER_PASSWORD` in `.env.server.local`). The browser becomes a device; "Log out" in Settings revokes it.

**Production shape.** Build to `dist/` and serve it from the same host as the API, with `/v1`, `/m`, `/s`, and `/e` passed to the server and everything else falling back to `index.html`; `../deploy/README.md` describes one live setup. The app assumes one origin: the login cookie, signed media URLs, and the public pages all live beside it. Over plain `http` on a LAN the clipboard API is unavailable, so Copy link falls back to the share sheet or a prompt.

## What is where

```text
src/api/        generated schema, openapi-fetch client (401 → login), type aliases
src/auth/       session store (device id and name; the token itself is only in the HttpOnly cookie)
src/player/     the engine around one <audio> element, playback reporter with its offline queue, scrubber, chapters, transcript
src/snips/      outbox (taps are stored first, sent in order), polling hook with If-None-Match, result card, clip preview
src/library/    subscribing: the subscribe sheet, a show's settings sheet, and the manual/automatic processing choice
src/screens/    Login, Today, Library, AddShow, FeedEpisodes, Player, SnipEditor, Snips, Prompts (prompt versions, scores, eval runs)
src/components/ icons, nav, mini player, episode row, sheets, toasts
src/lib/        router, data hooks, time formatting, ULIDs, storage, media URL handling
public/         manifest, icons, the app-shell service worker (registered in production builds only)
```

## Layout

One stylesheet, three layouts: upright, wide (`(orientation: landscape) and (min-width: 640px)`, `WIDE_QUERY` in `src/lib/layout.ts`), and desktop (wide and at least 1024 × 600, `DESKTOP_QUERY`), each mirrored in `styles.css`.

- **Upright** (phones, the iPhone Duo's outer screen, or its inner screen turned tall): one column up to 480 px wide (560 px from 600 px of width), tab bar and mini player at the bottom, the player stacked from artwork to transcript, sheets rising from the bottom. The transcript keeps at least a quarter of the screen's height (`--t-min`): the artwork's box shrinks first and the cover is dropped below about 96 px, and below 640 px of height the column tightens. While the snip card is up, the title row and the Chapters/Transcript tabs make way so the transcript shows between Snip and the card.
- **Wide** (the Duo's inner screen held wide, 951 × 669 pt, or a phone on its side): vertical space is scarce and horizontal space abundant, so navigation becomes a left rail with Now Playing at its foot and lists widen to 720 px. The player and editor split into two equal columns, controls on the left and the full-height transcript or chapters on the right, so that on a book-style foldable the hinge falls in the gap rather than through the text. The snip card and the episode's snip list dock over the foot of the reading column, within reach of the other thumb; the controls never move. Below 470 px of height (a phone on its side) the large artwork goes and the controls tighten so the whole column fits. Below 380 px (Safari's address bar and tab strip showing on a phone on its side leave about 300 px on an iPhone 17 Pro Max) the "Now playing" label, the show line, and the status line go too, and every control row shrinks, so Play, Snip, and the seek bar still fit.
- **Desktop** (a laptop or monitor browser window, or an iPad full screen; the Duo's 951 px stays wide): builds on the wide layout. The rail stays on every screen, the player and editor included (Now Playing hides on the player itself). Pages take up to 1000 px (1240 px for list-and-detail pages) instead of a phone's width: Prompts is a table, a prompt shows its versions beside the chosen version's text and runs, Snips lists snips beside the chosen one with every action showing and its title edited in place by clicking it (Enter or clicking away saves, Escape cancels; a title-only PATCH, no new revision), Library is a grid of covers. The player and editor use a fixed 420 px controls column and a reading column up to 820 px; the snip card and snip list sit at the foot of the reading column. Sheets become centred dialogs with a close button, and a sheet given the button that opened it (`anchor`, the episode options and Settings) opens as a popover under that button. Type stays as large as on the phone. Check at 1440 × 900 and 1280 × 800.

Anything with a pointer gets hover states (`@media (hover: hover)`, so never on a phone). Sheets take focus when they open, keep Tab inside, and give focus back on close. In the player, Space plays or pauses and ← / → skip 15 / 30 s unless a control or field has focus.

The two halves of the player and editor are plain wrappers (`.player__side` / `.player__main`, `.editor__side` / `.editor__main`) that are `display: contents` upright and become the columns wide, so the single-column CSS is untouched by the wide layout. Leading and trailing safe-area insets are applied separately (`--safe-l`, `--safe-r`): on the Duo the Dynamic Island sits at one side, so the insets differ. Check layout changes at 951 × 669, 669 × 951, 466 × 678, 956 × 297 (Pro Max in Safari, landscape), and iPhone 14 sizes both ways.

## How the client uses the API

- **Login**: `POST /v1/devices` with `{name, platform: "web", password, set_cookie: true}`. Every later call relies on the `pp_device` cookie; any 401 clears the local session and shows the login screen. There is no logout route, so Settings → Log out calls `DELETE /v1/devices/{id}` on its own device.
- **Library**: `GET /v1/feeds`, showing `kind: "podcast"` feeds only; a text feed marks its podcast as having publisher text. Episodes come from `GET /v1/episodes?feed_id=&limit=&after=` and the list follows `next`. Each row shows the `processing` state and the resume position.
- **Add a show** (`/library/add`, the search button on Library): typing searches `GET /v1/search/shows?q=&limit=20` (debounced 400 ms; Apple Podcasts, or Podcast Index when the server has its keys), and results already in the library open their show instead (`feed_id`). Pasting a feed address (`lib/feedUrl.ts`) offers to subscribe to that address directly, which is how private feeds are added. Subscribing is `POST /v1/feeds` with `auto_process: false, backfill: 0` unless the owner picks Automatic in the sheet, because automatic processing transcribes every new episode (billed); its "also process the 2 newest" box sends `backfill: 2`. The new show's page polls `GET /v1/feeds` every 2 s until its first refresh lands. A show's ⋯ menu switches manual/automatic (`PATCH /v1/feeds/{id}`, applies to episodes published from then on) and unsubscribes (`DELETE /v1/feeds/{id}`, which the server refuses while snips use the show's recordings).
- **Today**: `GET /v1/episodes?limit=30` across feeds; the episode with the most recent unfinished `resume` is "Continue listening", the rest are "New episodes".
- **Player**: `GET /v1/episodes/{id}`. When `asset` is null the client calls `POST /v1/episodes/{id}/audio` and polls the episode every 2 s until the recording exists. Playback uses `asset.audio_url` by path (the signature covers id, expiry, and device, not the host). An expired signed URL is renewed once by refetching the episode at the same position.
- **Engine** (docs/core/01-playback.md): heard audio is tracked as merged intervals (`player/heard.ts`): a seek closes the current stretch, a pause never does, and `heard_from_ms` is the start of the stretch containing the tap. `PUT /v1/playback/{asset_id}` is sent every 15 s while playing and immediately on play, pause, seek, speed change, end, tab hide, and page unload (`fetch` with `keepalive`). `seq` is a per-device counter in localStorage; reports that fail wait in localStorage (latest per asset) and replay in seq order when the connection returns. `finished` is set on the `ended` event or by "Mark as played". Media Session metadata, play/pause/seek handlers, and position state are set for the lock screen.
- **Chapters and transcript**: `episode.chapters.items` seek the player and segment the scrubber. The transcript is `GET /v1/transcripts/{id}` for `episode.transcript_id`, cached in memory; the current segment is found by binary search on segment starts and its current word highlighted. Following keeps the spoken word's line a third of the way down the part of the transcript that is visible, above the snip card when it is up, and steps a line at a time; it re-aims when the card comes or goes or the screen turns, and jumps without animation after a seek. Scrolling (wheel, touch, keys) stops following; "Follow audio" resumes it.
- **Video** (docs/video-plan.md): a recording with a picture plays through the engine's `<video>` element instead of its `<audio>` one (`player/engine.ts`: one of each, bound alike, the idle one holding no stream), shown by `player/VideoSurface.tsx` where the artwork goes. The element never leaves the document, because a media element taken out of it pauses: with no surface on screen it waits unseen in the engine's holder and the sound carries on. Upright, the picture keeps its whole frame and scales down rather than crops; compact and short landscape layouts show it smaller. Full screen is the corner button, or a tap on a small picture; iPhone Safari uses its own full-screen player, and the engine plays on when that closes. Safari pauses video when the phone locks, so listening with the screen off needs "Sound only" or the native app. "Play video" / "Sound only" in the ⋯ menu is the owner's choice, kept in `pp.video`; with sound only the audio file plays, so nothing streams the picture. "Watch video" there asks the server for an episode's video (`POST /v1/episodes/{id}/video`); while `video.status` is `requested` the player reads the episode every 5 s and, once the video is the recording, plays on from the same spot. Today and the Library filter All / Podcasts / Videos (`pp.mediaFilter`); a YouTube channel pasted into Add a show is followed like a feed.
- **Up next**: the player's third tab (`player/UpNext.tsx`, `player/queue.ts`), `GET /v1/queue` without the playing episode. Rows move by dragging their handle (pointer events, so mouse and touch) or with the arrow keys on a focused handle, saved with `PUT /v1/queue`; × is `DELETE /v1/queue/{id}`; an episode row's list-plus button is `POST /v1/queue/{id}`, which also has the server fetch and transcribe it. When an episode ends, the engine's `onEnded` opens the first up next with autoplay, and a player showing the one that ended moves on to it. Opening an episode from a list never starts it; its row's play button does.
- **Snip**: the button stores `{client_request_id (ULID), asset_id, anchor_ms, heard_from_ms}` in a localStorage outbox, then sends `POST /v1/snips`. A tap made offline shows "Waiting for connection" and is delivered on the `online` event; the same ids make resends harmless. The result card polls `GET /v1/snips/{id}` with `If-None-Match` every 2 s until `revision.status` is `ready` or `failed`, then offers Play clip (`revision.clip_url`, previewed on a separate element that never reports playback), Edit, and Copy link (`share_url`). Once the moment is chosen, tapping the card's title edits it in place (`snips/TitleEdit.tsx`, the same box as the Snips page; Escape there ends the edit, not the card).
- **Editor**: `PATCH /v1/snips/{id}` with `start_ms`, `end_ms`, optional `title`, and `if_revision`; a 409 is shown as "changed elsewhere". Word taps and the ±1 s / ±5 s buttons move the selected point; "Play snip" previews the span from the full recording.
- **Episode page**: the episode's snip list reads `GET /v1/episodes/{id}/share` (null until shared). "Share all" sends an active page to the system share sheet (`navigator.share`, over HTTPS) or copies it; the first time it calls `POST /v1/episodes/{id}/share` and copies the link through a `ClipboardItem` holding a promise, since Safari only allows a clipboard write during the tap. "Stop sharing" is `POST /v1/episodes/{id}/share/revoke`. Links are built on the address the app is open at, because public pages live on the app's host and `PUBLIC_BASE_URL` can be a loopback address in development. The dev server proxies `/e/` to the API like `/s/`.
- **Snips**: `GET /v1/snips?q=&limit=&after=`, `POST /v1/snips/{id}/revoke`, `POST /v1/snips/{id}/restore`, `DELETE /v1/snips/{id}`.

Nothing is decided client-side that the server owns: selection, summaries, publication, and which transcript is current all come from responses as they are.

## Requests for the API

Things the client would use but does not have. None is worked around with client-side rules; each is simply absent from the UI or handled with the closest available data.

1. **Use `revision.transcript_id` in the editor.** The server now returns it. The editor still loads the episode's *current* transcript, so if that changed after a snip was made (ASR replaced by aligned publisher text, say), the highlighted words may not be the revision's exact words. Loading `GET /v1/transcripts/{revision.transcript_id}` instead would fix it.
2. **A logout route that clears the cookie.** Revoking the device works, but the stale cookie stays in the browser until it expires.
3. **`snip_count` on episode list items.** The design's Continue-listening card shows "1 snip"; only the episode detail has the count today.
4. **A session check** such as `GET /v1/devices/me`. On a cold start the client trusts localStorage and learns the cookie is dead only from the first 401; a cheap check would let it show the login screen without a failed data request.
5. **Path-relative media URLs, or honouring the request host.** `audio_url` and `clip_url` are absolute from `PUBLIC_BASE_URL`. The client plays them by path so the dev proxy and LAN testing work; relative URLs in the contract would make this an explicit guarantee rather than a client choice.
6. **Redact credentials in `episode.link`.** For a private feed the link can carry the publisher's access token. The client never displays or copies it, but it would be safer not to send it.
7. **Played/unplayed filtering and transcript search** on `GET /v1/episodes`, which the product doc lists for Library; not needed for this first pass.

## Not in this pass

No episode share composer, no transcript search, no sleep timer (by decision). The icons are placeholders. Lock-screen controls and background audio on iPhone Safari follow the Media Session code paths but were checked in headless Chromium and WebKit, not on a device.
