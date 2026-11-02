# CLAUDE.md — the iOS app

Read ../CLAUDE.md first: its side effects (paid transcription, auto-published snips, the deploy checkout that
commits by itself) apply to anything the app does against a real server. The owner's own hosts, accounts and
bundle id are in ../CLAUDE.local.md and the gitignored `Config/Local.xcconfig` and `scripts/local.env`, never here.

- **Build and test.** `ios/scripts/test.sh` (packages, macOS, seconds); `ios/scripts/dev-build-run.sh` (simulator).
  `xcodebuild test -scheme Snip` runs the same package tests in the simulator. Neither needs an Apple team.
- **Never work around a server gap in the client.** Change the server first, then
  `pnpm --dir server openapi:update` and `pnpm --dir server api-fixtures:update`; `DecodeFixturesTests` then tells
  you which model to change. A new recording in contracts/api/ needs an entry in that test's table.
- **HeardTracker is a port, not a design.** It must match contracts/golden/heard/heard_v1.json. A behaviour change
  starts in web/src/player/heard.ts under a new version. It moves to the shared SnipCore package once that exists.
- **Prefer the local server.** The simulator against production plays real episodes (paid transcription on
  `auto_process` feeds) and creates real, public snips. Locally: `scripts/dev-snapshot.sh` once, then
  `scripts/dev-server.sh` (paid services forced off), then launch the app with `-server.url http://localhost:8080`
  (`xcrun simctl launch booted <bundle id> -server.url http://localhost:8080`; the bundle id is
  `$(ORG_IDENTIFIER).Snip` from `Config/Local.xcconfig`, and `dev-build-run.sh` prints it) and sign in with the
  `OWNER_PASSWORD` in the repo's `.env.local`. `~/.config/podcast-player/devauth.json` doesn't help here: it
  replaces the server with the one it names. A file of the same shape naming `http://localhost:8080` works through
  `SIMCTL_CHILD_SNIP_DEV_AUTH_FILE`, since the snapshot carries production's device rows and so accepts the same token.
  Always add `-muteAudio 1` to a scripted launch: the owner uses the Mac's speakers while sessions run, so test
  playback must stay silent (the app mutes its player; the Mac's volume is never touched).
  Against production, for a final check only: an SSH tunnel to the server (`ssh -N -L 8081:127.0.0.1:8080 <host>`)
  and `-server.url http://localhost:8081`, on episodes whose transcript is already ready.
- **Ship to the phone** with `ios/scripts/testflight.sh` (profile, archive, upload; the build lands in the internal
  "Owner" TestFlight group). It reads the team and App Store Connect key from `scripts/local.env` and refuses
  without them. Release builds start on `PODCAST_SERVER_URL` from `Config/Local.xcconfig`; a build with none set
  starts with a blank login screen.
- **Media auth is signed URLs only.** Do not inject headers into AVPlayer (`AVURLAssetHTTPHeaderFieldsKey` is
  private API).
- **Don't copy MPL-2.0 code from audiobooth-fork** (`PlayerManager`, `AudioPlayer`, `NowPlayingManager`, ...);
  plan §2.7 lists what may be copied.
- New app files go under `Snip/` and are picked up automatically; the pbxproj only changes for targets, packages
  and build settings.
- **Live Activity** (lock screen, Dynamic Island) is a second target, `SnipLiveActivity/` (bundle
  `$(ORG_IDENTIFIER).Snip.LiveActivity`, embedded in the app). What both sides must agree on (the activity's state,
  the buttons' `LiveActivityIntent`s) lives in `Packages/SnipActivity`, which both link; the intents run in the app's
  process through `PlaybackActivityControl.handler`. `testflight.sh` mints an App Store profile for each bundle and
  passes them as `SNIP_APP_PROFILE` / `SNIP_EXTENSION_PROFILE`.
- **Nothing of one deployment in the code.** Identifiers derive from the bundle id (`TokenStore.defaultService`,
  `DownloadStore.sessionIdentifier`); the default server comes from Info.plist through the xcconfigs. A hostname,
  team or account that belongs to the owner goes in the gitignored files above, not in a Swift file, a script or a doc.
