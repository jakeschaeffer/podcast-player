# Starting the native podcast app

A brief for the session that builds the iOS app on a Mac. Read [CLAUDE.md](../CLAUDE.md) first, then Part 2 of
[cross-repo-snips-plan.md](cross-repo-snips-plan.md) (the design) and its Roadmap (M7, M10). This page says what
is already in place on the server side and what to build first.

## What is already in place (branch `claude/native-app-prep`)

| You need | Where it is |
| --- | --- |
| The API contract | `server/openapi.json` (committed; a server test fails when it drifts) |
| Real responses to decode in unit tests | `contracts/api/*.json`, one per endpoint and state; see its README |
| Exact behaviour for the heard tracker the player must port | `contracts/golden/heard/heard_v1.json` (reference `web/src/player/heard.ts`) |
| Exact In/Out editor rules | `contracts/golden/span-points/span_points_v1.json` (reference `web/src/lib/spanPoints.ts`) |
| Offline-safe writes | `if_revision` required on boundary edits; DELETE is idempotent; `observed_at` on playback and `captured_at` on snips order replays correctly; a replayed `POST /v1/snips` returns 200 with the same id |
| Login for a native client | `POST /v1/devices {name, platform: "ios", password}` returns a token once; send `Authorization: Bearer <token>` |
| Audio | `episode.asset.audio_url` is a signed, expiring URL (the `e` query parameter is its expiry in Unix seconds) that AVPlayer can play with no headers; Range is supported |

Selection, clips, titles and summaries stay on the server for this app: it only sends a tap and polls.

## Blocked on the owner

1. **Cloudflare Access.** The API and audio sit behind a Google login a native app cannot complete. Look at the
   Zero Trust dashboard, then add `v1` and `m` to the bypass application that already lets `s` and `e` through. The server-side hardening for that is done (login lockout, token-only API description, media
   URLs revoked with their device). Until then, develop against `pnpm --dir server dev` on the Mac or the tailnet.
2. **Bundle id and app group**, fixed on day one (`$(ORG_IDENTIFIER).Snip`, from the gitignored `ios/Config/Local.xcconfig`).

## Build first (M7 in the roadmap)

1. `ios/` scaffold per plan §2.3: an app target that holds only views, plus local packages `PodcastAPI`, `PlayerKit`,
   `SyncKit`. Minimum iOS 26 (single-user TestFlight app).
2. `PodcastAPI`: a hand-written client (plan §2.4) with `Codable` models. Its first test decodes every file in
   `contracts/api/`; copy them into the package's test resources with a small script, or reference them by path.
3. `PlayerKit`: AVPlayer engine, `HeardTracker` port tested against `heard_v1.json`, playback reporter with the
   per-device `seq`, and `observed_at` sent on every report.
4. Screens Login → Today → Library → Feed episodes → Player, then TestFlight (reuse the audiobook fork's headless
   pipeline; see the plan §2.7 for what may be copied and what must be rewritten because of MPL-2.0).

Snips (M10) come next: the outbox (`client_request_id`, `captured_at`), ETag polling, the editor using the
span-point rules, and the Snips list.

## Keep the contract honest

When the app needs something the server does not do, change the server in this repo first (route, schema, tests),
run `pnpm --dir server openapi:update` and `pnpm --dir server api-fixtures:update`, then build the app against the
new files. Never work around a server gap in the client: the web app and the native app must stay thin over the
same API.
