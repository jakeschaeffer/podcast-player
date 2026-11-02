# Snip for iOS

The native podcast app: a SwiftUI client over the same server API as the web app (`../server`). Design and
roadmap: [docs/cross-repo-snips-plan.md](../docs/cross-repo-snips-plan.md) Part 2, and
[docs/native-app-start.md](../docs/native-app-start.md). This is milestone M7 (the listening loop) in progress.

## Layout

```
Snip.xcodeproj        app target only; the Snip/ folder is a file-system-synchronized group (add files, no pbxproj edits)
Snip/                 SnipApp, AppModel (wires client, engine, outboxes), Screens/<Screen>/
Config/               Signing.xcconfig (defaults), Local.xcconfig.example (your team, org id, default server), Info.plist
Packages/
  PodcastAPI/         hand-written client, Codable models, Keychain token store; decode tests read ../contracts/api
  PlayerKit/          AVPlayer engine, lock-screen controls, HeardTracker port; golden tests read ../contracts/golden
  SyncKit/            offline playback reporter (per-device seq, latest per asset), RetryPolicy
scripts/              dev-build-run.sh (simulator), test.sh (all package tests on macOS)
```

Dependencies run one way: app → PlayerKit, SyncKit → PodcastAPI. Packages never import the app. Logic goes in a
package so `swift test` covers it in seconds; the app target holds views and wiring.

## Run it

```bash
ios/scripts/test.sh            # every package's tests on macOS
ios/scripts/dev-build-run.sh   # build, install and launch in the simulator
```

Or open `ios/Snip.xcodeproj` and run the **Snip** scheme (Cmd-U runs the package tests).

The login screen asks for a server and the owner password. A Debug build offers `http://localhost:8080`, which
the simulator reaches on the Mac; a Release build offers whatever `Config/Local.xcconfig` names, or nothing. Two
ways to have something at the local address:

- **A local server with nothing paid.** Write `.env.local` at the repo root with `APP_SECRET`, `OWNER_PASSWORD`,
  `TEXT_MODEL=none`, a `DATA_DIR` outside the repo and `REFRESH_INTERVAL_MINUTES=0`, and no `ELEVENLABS_API_KEY`
  (transcription is then deferred, never billed). Run `pnpm --dir server dev`, add a public feed with
  `auto_process: false`, and sign in.
- **Production through an SSH tunnel**: `ssh -N -L 8081:127.0.0.1:8080 <your host>`, then sign in to
  `http://localhost:8081`. Audio plays through the tunnel too, because the app plays signed `/m/` URLs by path on
  the server it talks to, like the web app's `mediaPath`. That is the real database:
  playing an untranscribed episode of an `auto_process` feed queues paid transcription, and every snip publishes
  a public link (see ../CLAUDE.md).

In the simulator, `~/.config/podcast-player/devauth.json` on the Mac (`{"server": "...", "token": "pp_..."}`, a
device token, never the password) signs the app in when its Keychain is empty; DEBUG builds only.

Release builds (TestFlight) start on `PODCAST_SERVER_URL` from `Config/Local.xcconfig` (gitignored), so a build
you share names no server of yours. The server must be reachable from the phone without a browser login:
[docs/SELF-HOSTING.md](../docs/SELF-HOSTING.md) lists the ways (a tailnet address from `tailscale serve`, a tunnel, a
reverse proxy that passes `/v1` and `/m`).

## TestFlight

`ios/scripts/testflight.sh` archives, signs with the account's Apple Distribution certificate and an App Store
profile that `scripts/asc.mjs` registers and mints through the App Store Connect API, and uploads with altool. It
reads your team, org id and App Store Connect key id from `scripts/local.env` (copy `local.env.example`); the key's
`.p8` sits at `~/.appstoreconnect/private_keys/`. The App Store Connect app (any name, bundle id
`$(ORG_IDENTIFIER).Snip`) is created once by hand; `asc.mjs` makes its internal TestFlight group "Owner", which has
access to every build, so an upload reaches the phone once processing finishes. Builds expire after 90 days.

## Status

| Done | Next |
| --- | --- |
| Login (Keychain token per server), Today, Library, show search and browsing a show without following it, feed episodes (paged), YouTube channels and single videos by pasted link, player (resume, scrub, skip 15/30, speed, chapters, Up next with drag ordering and auto-advance, open paused), follow-along transcript with text size, karaoke read-along sideways, video (inline, and full screen sideways with the controls over it), lock screen, Live Activity and remote commands, signed-URL renewal, playback reports with `observed_at` and an offline outbox, downloads for offline playing; snips: create (offline outbox), card with ETag polling and in-place title edits, clip and share, Snips tab, per-episode snips sheet, editor (title, In/Out by word tap or ±1/±5 s, preview, `if_revision`; span rules pass `span_points_v1`), Prompts screens (updated 2026-11-01) | `NWPathMonitor` flushes, `beginBackgroundTask` on background; snip search, revoke/restore, delete; SponsorBlock; video clips on public pages |

## Downloads

`DownloadStore` (PlayerKit) keeps recordings on the phone for playing with no connection: a background `URLSession`
(`<bundle id>.downloads`, resumed by `AppDelegate`) fetches the asset's video (when video is wanted and it
has one) or audio into `Application Support/downloads/<server host>/`, and the episode's details and transcript are
saved beside it. The player, the transcript and the karaoke view fall back to those saved copies when the server
cannot be reached (`PlayerEngine.open`, `TranscriptCache.load`); `attach` plays the local file instead of a stream
when there is one (`engine.offline`, which also stops signed-URL renewal). Nothing else changes: a snip tap and a
playback report go to their outboxes as they always did, so snips never depend on a download. The Downloads screen
(account menu) lists what is on the phone and its size, with "Keep Up next on the phone" (the first one or three of Up
next are downloaded by themselves after each queue read) and "Download on cellular" (decided per download). A
download of an episode finished on the phone goes by itself a day later; removing the last download of an episode
takes its details and transcript with it.

## Video

A recording with a picture (docs/video-plan.md) plays through the same `PlayerEngine` and `AVPlayer`: `attach` loads
the asset's `videoUrl` instead of its `audioUrl` when video is wanted (`player.video` in UserDefaults, default on), and
`VideoSurface` puts an `AVPlayerLayer` on the engine's player where the artwork goes (above the titles upright).
Turned sideways, a video fills the screen with the player's own controls laid over it (`VideoSideways`: `Scrubber`
and `TransportRow`, shared with the upright player; a tap brings them up, they go by themselves while the video
plays and stay while it is paused), whatever the "Turned sideways" setting says for audio episodes. In the background
the layer lets go of the player, which is what keeps the sound playing.
"Watch video" under the title asks the server for an episode's video (`requestVideo`); while it is on its way the
player reads the episode every 5 s and, once the video is the recording, plays on from the same spot. "Video" /
"Sound only" switches at the current position. Today and the Library filter All / Podcasts / Videos (`mediaFilter`).
The show search takes YouTube links too (`YouTubeLink`): a channel link or bare `@handle` opens the channel as a show
(`POST /v1/feeds` resolves it), and a video link makes the video an episode of its channel's show and opens it in the
player (`POST /v1/youtube/episodes`); the channel stays unfollowed until followed from its page. A link to a video or
audio file (`MediaLink`, by extension) becomes a one-off episode of the "Pasted links" show, which the server downloads
and transcribes (`POST /v1/links/episodes`, docs/video-plan.md); the Library lists that show, and its page has nothing
to follow. A link to a web page is refused with the server's message.

## Design notes

A design pass on 2026-11-01 reviewed every screen in light, dark and sideways. Conventions it settled: orange marks the
primary action and nothing else is off-palette (swipe actions included); captions are footnote and secondary; "Up Next"
is spelled that way everywhere; a snip's time reads `5:05 · 1 min 31 sec`; during an ad, Skip ad stands in the speed
button's slot so the controls never move; the snip page's play glyph says whether the clip plays audio or video. Scripted
simulator runs pass `-muteAudio 1`, and `-snipMode adjust` opens a snip page in the editor for screenshots.
