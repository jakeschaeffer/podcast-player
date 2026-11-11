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
  the buttons' `LiveActivityIntent`s) and its views live in `Packages/SnipActivity`, which both link; the extension
  only places the views, and the intents run in the app's process through `PlaybackActivityControl.handler`. Play,
  pause and the skips are left to the system's Now Playing card: the activity shows the title and position with Snip,
  an ad break with Skip ad, and a snip's steps until its title is in (Play joins whichever it is while paused). A tap on that title
  opens the app renaming it (`SnipLink`: the URL scheme is the app's bundle id, registered in `Config/Info.plist`).
  Its tests run in the simulator only (`xcodebuild test -scheme Snip`): ActivityKit has no macOS. `testflight.sh`
  mints an App Store profile for each bundle and passes them as `SNIP_APP_PROFILE` / `SNIP_EXTENSION_PROFILE` /
  `SNIP_SHARE_PROFILE`.
- **The activity's buttons run with the app out of sight**, often in a process iOS launched just for the press
  after ending the app while it was paused. Nothing may depend on a screen having been drawn: the model is made in
  `SnipApp.init` (`AppModel.shared`), because `@State` builds an observable object only when a view reads it, and a
  launch with no view once left every button dead. To check one: play, pause, send the app to the background
  (`xcrun simctl launch <udid> com.apple.Preferences`), `xcrun simctl terminate` it, long-press the island and tap
  the button; `log show --predicate 'subsystem == "snip.player"'` says what the relaunched app found. Persist the
  mute first (`xcrun simctl spawn <udid> defaults write <bundle id> muteAudio -bool YES`): the system's relaunch
  carries no launch arguments. The simulator never suspends a paused app, so "the app is suspended" is tested by
  ending it.
- **Design checks of the Live Activity.** A script can't lock the simulator, so `-activityGallery lock|ad|snip|snip2|
  island|island2|compact|paused|paused2` (DEBUG) draws every state at real size with the activity's own views. The compact island shows
  for real once the app is in the background (`xcrun simctl launch <udid> com.apple.Preferences`); `-openEpisode <id>
  -seekTo <ms> -autoSnipAfter <s> -renameAfter <s>` plays into an ad break, snips, and opens the rename link.
- **Share sheet** is a third target, `SnipShare/` (bundle `$(ORG_IDENTIFIER).Snip.Share`, a share extension embedded
  in the app). It runs in its own process with none of the app's state and no DEBUG dev-auth, so it reads the server
  and the device token from the Keychain through the app's access group (`Config/*.entitlements` name
  `$(AppIdentifierPrefix)$(ORG_IDENTIFIER).Snip` on both targets; `SharedSession` in PodcastAPI), then calls the
  server itself: a channel link is followed (`POST /v1/feeds`), any other link becomes an episode
  (`POST /v1/links/episodes`). In the simulator, share a page from Safari to try it; the app must have been opened
  signed in once, since it writes the server to the Keychain at launch.
- **A snip tap is saved, shown, then sent** (`SnipOutbox.add`, then `flush`). One the server can't take stays on
  the phone (`AppModel.waitingSnips`, the Snips tab's "Waiting to send", the bar's "Not sent yet"), with a default
  span of 90 s. A title, a note or another length given meanwhile (`WaitingSnipSheet`) rides in the tap's `owner`
  field; the server still lets its selector choose first and then puts the owner's span over it as a manual
  revision, so nothing typed offline is overridden. To test: stop only the server's listener
  (`lsof -ti tcp:8080 -sTCP:LISTEN | xargs kill`; without `-sTCP:LISTEN` that also kills the simulator app, which
  holds a connection on the port), tap Snip, edit, start the server, and bring the app to the front to flush.
- **Nothing of one deployment in the code.** Identifiers derive from the bundle id (`TokenStore.defaultService`,
  `DownloadStore.sessionIdentifier`); the default server comes from Info.plist through the xcconfigs. A hostname,
  team or account that belongs to the owner goes in the gitignored files above, not in a Swift file, a script or a doc.
