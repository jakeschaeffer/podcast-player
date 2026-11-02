# Running your own

Snip is one server, a web app served beside it, and an iOS app that talks to it. Nothing about any particular
deployment is compiled in: you run the server somewhere the phone can reach, build the app under your own Apple
team, and type the server's address once on the login screen. [deploy/README.md](../deploy/README.md) is one
complete working setup, to compare yours against.

## What you get, and what it needs

| you get | you need |
| --- | --- |
| Shows and episodes, playback with your place kept across devices, Up Next, the web app | the **server** (Node 22, ffmpeg) and a place to run it |
| Transcripts, follow-along text, snips with exact words, ad skipping | an **ElevenLabs** key (Scribe v2, about 22¢ an hour of audio) |
| Snip titles, episode previews, AI chapters, speaker names | the **Codex CLI**, signed in to your subscription, on the server |
| The iOS app on your phone: offline downloads, Live Activity, video | a Mac with **Xcode 26**, an Apple Developer team for a phone (the simulator needs none) |
| The publisher's own text lined up with the audio | a text feed or newsletter emails from the publisher (optional) |
| YouTube channels as shows, and videos for podcast episodes | the **home fetcher** on a box at home (optional) |

Everything beyond the first row is optional and switches on by configuration.

## What runs where

```text
 phone / browser
   │  one address ───────────▶ nginx (or any proxy) ──▶ server :8080   API, signed media, public /s and /e pages
   │                              └─ everything else ──▶ web/dist        the web app, same origin
   │
   │  (snips publish here)     ──▶ PUBLIC_BASE_URL/s/<token>            anyone can open these
   │
 home box (optional)  ──────────▶ server                                 fetcher/: yt-dlp at home, uploads to the server
```

The app assumes **one origin**: the login cookie, the signed media URLs and the public pages all live beside the
API. Put the server and `web/dist` behind one hostname.

## 1. The server

```bash
git clone <your fork> && cd podcast-player
pnpm install
pnpm -r test                     # no keys, no network; the adapters are faked
```

Settings come from `.env.local` at the repository root (gitignored; `server/README.md` has the full table).
`scripts/dev-server.sh` writes one with a random `APP_SECRET` and `OWNER_PASSWORD` the first time and runs the
server with every paid service forced off, which is the right first run. For a real server:

| variable | set it to |
| --- | --- |
| `APP_SECRET` | any long random string. It encrypts stored feed URLs and signs media URLs; changing it orphans your feeds |
| `OWNER_PASSWORD` | the password the apps sign in with. One owner; every device is that owner |
| `PUBLIC_BASE_URL` | the origin the phone and browsers use, e.g. `https://snip.example.com`; it goes into share links |
| `DATA_DIR` | where `app.db` and the recordings live (plan for the recordings: hours of audio add up) |
| `ELEVENLABS_API_KEY` | your key. Without it, transcription jobs wait and nothing is billed |
| `TEXT_MODEL` | `codex-cli` with the Codex CLI installed and signed in on that machine; `none` otherwise |
| `SHARE_BY_NAME` | the name on share cards ("10 clips from Ada"); empty leaves just the count |
| `VIDEO_MAX_HEIGHT` | videos the server fetches are scaled down to this height (480) before they are kept; `0` keeps them as they come |
| `TRANSCRIPTION_BUDGET_MINUTES` | a monthly cap on automatic transcription (default 6000 minutes) |
| `PODCASTINDEX_KEY`, `PODCASTINDEX_SECRET` | optional: show search through Podcast Index instead of the keyless iTunes API |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `EMAIL_SOURCE_QUERY` | optional: publisher emails as a text source (`pnpm --dir server gmail:auth`) |

```bash
pnpm --dir server build && pnpm --dir server start      # API and worker in one process on 127.0.0.1:8080
pnpm --dir web build                                    # web/dist, static files to serve beside the API
```

Migrations run on start. `deploy/systemd/podcast-player.service` is a unit to copy; `deploy/deploy.sh` is a
one-command deploy for a server that runs the checkout itself (it pulls `origin/master`, installs, rebuilds the web
app, waits for running jobs, restarts, checks health), driven by the gitignored `deploy/local.env`.

**Costs.** ElevenLabs bills per audio hour, and the server queues transcription when you play an untranscribed
episode of a show set to process automatically, when you snip one, or when you ask (`POST /v1/episodes/{id}/process`).
Shows added with `auto_process: false` are listed and playable but transcribe nothing until asked. Every snip
summary and episode summary is a Codex call.

## 2. Reaching it

The phone needs the server at one https address it can reach from anywhere it listens, with no browser login in
front of `/v1` and `/m` (the app cannot complete one). Pick one:

- **A tailnet (Tailscale).** On the server, `tailscale serve --bg --https=8443 http://127.0.0.1:<nginx port>`
  serves `https://<machine>.<tailnet>.ts.net:8443` to your devices only, with a certificate the phone trusts. The
  phone needs Tailscale on. This is what the worked setup does for the app.
- **A Cloudflare tunnel** in front of nginx: `deploy/` has the nginx site, the tunnel config and the units. If you
  put Cloudflare Access in front of it, bypass `/s` and `/e` (public pages) and let `/v1` and `/m` through for the
  app; the server has its own login and lockout.
- **Any reverse proxy with https.** It must send `X-Forwarded-Proto` (the login cookie's `Secure` flag follows
  it), stream `/m` without buffering (audio with Range requests), never cache `/v1`, `/m`, `/s` or `/e` at an
  edge (a revoked snip must stop serving at once), and ideally rate-limit `POST /v1/devices` (the password
  login). `deploy/nginx/` does all four.
- **The same network only.** `http://<machine>:8080` works for the simulator and for browsers on the LAN; the
  phone app over plain http reaches local addresses only, not a tailnet one.

Never forward the raw port to the internet: the server has one password and no other protection of its own.

## 3. The iOS app

A Mac with Xcode 26. A paid Apple Developer account for a phone; the simulator needs neither a team nor an account.

```bash
cp ios/Config/Local.xcconfig.example ios/Config/Local.xcconfig     # your team, org id, default server
ios/scripts/test.sh                                                # the packages' tests, on macOS, seconds
ios/scripts/dev-build-run.sh                                       # build, install and launch in the simulator
```

`ORG_IDENTIFIER` in `Local.xcconfig` makes the app `<org>.Snip` (and its Live Activity `<org>.Snip.LiveActivity`).
Pick it once: the Keychain token and in-flight downloads are keyed by it on every phone that has the app.

The login screen asks for the server's address and `OWNER_PASSWORD`. A Debug build offers `http://localhost:8080`
(a local server; `scripts/dev-server.sh`); a Release build offers `PODCAST_SERVER_URL` from your `Local.xcconfig`,
or nothing. The phone keeps the server it signed in with.

**TestFlight.** `ios/scripts/testflight.sh` archives, signs and uploads, headless. It needs, once:

1. An App Store Connect app for your bundle id (App Store Connect → Apps → +), any name.
2. An App Store Connect API key with the App Manager role (Users and Access → Integrations → Team Keys), its
   `.p8` at `~/.appstoreconnect/private_keys/AuthKey_<key id>.p8`.
3. An Apple Distribution certificate on the Mac (Xcode → Settings → Accounts → Manage Certificates).
4. `cp ios/scripts/local.env.example ios/scripts/local.env` with your team, org id, key id and issuer.

The script registers the bundle ids (the app, its Live Activity and its share extension), mints App Store profiles
named `AS <bundle id>`, makes an internal TestFlight group "Owner" with the account holder in it, and uploads. Internal testing needs no review; the build reaches your
phone once processing finishes, and expires after 90 days. To let someone else use your build, add them to a
TestFlight group; they type their own server's address on the login screen.

## 4. Shows

Sign in, then search for a show or paste a feed URL (private feeds carry their credential in the URL; it is stored
encrypted). YouTube channel links and `@handles` become shows too, and a pasted YouTube video link becomes an episode,
once the fetcher runs. A link straight to a video or audio file becomes a one-off episode of a "Pasted links" show,
which the server downloads and transcribes itself; a link to a web page does not work (that would need the fetcher). `auto_process` on a show decides whether new episodes are fetched, transcribed and summarised on
their own or only when you ask.

Publishers who post the text of each episode (a second RSS feed, or a newsletter) can have it attached as a **text
feed**; the server lines it up with the audio by forced alignment (billed like transcription) and uses it for ad
detection and, for article-style episodes, as the transcript.

## 5. The home fetcher (optional)

YouTube blocks downloads from data-centre addresses, so videos are fetched by a small script on a box at home and
uploaded to the server: [fetcher/README.md](../fetcher/README.md). It needs Python 3, yt-dlp, a device token
(made with the owner password) and `SNIP_SERVER` set to the server's address.

## Checking it works

| check | how |
| --- | --- |
| The server is up | `curl https://<server>/v1/health` |
| A device can log in | `curl -X POST https://<server>/v1/devices -H 'content-type: application/json' -d '{"name":"laptop","platform":"cli","password":"…"}'` returns a token |
| The app decodes what the server sends | `ios/scripts/check-live.sh https://<server>` (reads real responses with the app's models) |
| Snips publish | make one; its public link opens in a signed-out browser |
| Transcription bills what you expect | `GET /v1/jobs` shows the queue; the cost ledger is per recording |

## Keeping it running

Per-machine files, each gitignored with a committed `.example` beside it. A new clone or worktree starts without
them; the simulator, the tests and a Debug build need none, and the scripts that need one refuse with its name.

| file | holds | needed by |
| --- | --- | --- |
| `.env.local` | the server's secrets and settings | the server |
| `ios/Config/Local.xcconfig` | Apple team, org id, the server release builds start on | phone builds |
| `ios/scripts/local.env` | team, org id, App Store Connect key id and issuer | `testflight.sh`, `asc.mjs` |
| `deploy/local.env` | the production host's ssh alias, user and checkout | `deploy.sh`, `dev-snapshot.sh` |
| `CLAUDE.local.md` | notes about your deployment for Claude Code sessions | sessions |

After pulling a change: `pnpm install` if the lockfile moved, then `pnpm -r typecheck && pnpm -r test`;
`deploy/deploy.sh` does the install and restart on the server. A server change that touches a route goes with
`pnpm --dir server openapi:update` and `pnpm --dir web gen:api` (CLAUDE.md). The files under `deploy/systemd`,
`deploy/nginx` and `deploy/cloudflared` are installed by hand; the deploy script says when one changed.

## Known limits

- **One owner.** One password, and every device that knows it is the owner; there are no accounts.
- **Snips publish on creation**, private feeds included. Revoking a snip takes its page and clip down.
- **ElevenLabs is the only transcriber today.** `server/src/adapters/transcriber.ts` is the interface another would
  implement; local Whisper was planned as a per-feed fallback and is not built.
- **Summaries need the Codex CLI** on the server; the text-model adapter (`server/src/adapters/textModel.ts`) is
  where another model would go.
- **iOS 26** is the app's minimum.
