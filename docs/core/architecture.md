# Architecture: the simplest system that holds the six functions

The parent [architecture.md](../architecture.md) surveys options and operational detail. This page records the shape actually chosen and the handful of decisions that are expensive to change later, especially once an iOS app exists.

## Shape

One TypeScript server, one SQLite file, one media directory, one web client, and later one native client that speaks the same API.

```text
podcast-player/
  server/                 one Node app; `--role api`, `--role worker`, or both
    src/core/             pure functions: feed, playback, selection, clip, transcript, summaries
    src/adapters/         elevenlabs.ts, whisper-local.ts, codex-cli.ts, llm-api.ts, ffmpeg.ts
    src/http/             Fastify composition root, auth, schemas, one route module per area: owner API (/v1), public pages (/s), media (/m)
    src/jobs/             the SQLite-backed queue and one handler per job kind
    src/db/               schema, migrations, typed queries
    prompts/              versioned prompt files, one folder per function
  web/                    React + Vite, installable PWA; a thin UI over the API and the player engine
  ios/                    later: SwiftUI, AVPlayer, a client generated from the OpenAPI document
  evals/                  one folder per core function: cases, runner, dated results
  data/                   runtime only, outside the repo: app.db and media/
```

Why this and not more:

- **One process type, two roles.** API and worker are the same code with the same database connection code, run as two systemd units so a slow transcription upload or an FFmpeg render never shares an event loop with a request. Crash isolation without a second deployable.
- **SQLite is the queue, the search index, and the store.** `job` is leased with a single `UPDATE ... RETURNING` statement; FTS5 indexes transcripts and snips; WAL mode gives concurrent readers. There is no Redis, no Postgres, no message broker to run on a 4-thread box. Node 22's `better-sqlite3` is synchronous, which is a feature here: no connection pool, and transactions are plain function calls. Verify the bundled SQLite is 3.51.3 or newer, per the parent architecture notes.
- **Functional core, imperative shell.** Every core function is `input → output` with no I/O; job handlers load the inputs, call the function, and write the outputs. The eval runners import the same functions. A bug found in production is reproduced by saving the input as a case.
- **Two adapter interfaces.** `Transcriber` and `TextModel` are the only places a provider name appears. Swapping ElevenLabs for Whisper, or Codex CLI for a direct API, is a config change and a new eval run, not a refactor.
- **Immutable artifacts.** Content-addressed assets, immutable transcripts, numbered revisions, and immutable clip URLs mean caching headers can be honest, races resolve by comparing ids, and the public page can be a static-feeling HTML response.
- **No framework on the public side.** `/s/{token}` is server-rendered HTML with a native audio element. It loads instantly in a messaging app's preview, works with scripts disabled, and has a surface small enough to audit for containment.

## The API, in full

About twenty owner routes, three public routes, two media routes. The route schemas (TypeBox in Fastify) generate the OpenAPI document; nothing is hand-written twice.

| Area | Routes |
| --- | --- |
| Auth | `POST /v1/devices` (login → device token), `DELETE /v1/devices/{id}` |
| Feeds | `GET /v1/search/shows`, `GET/POST /v1/feeds` (podcast or text), `GET/PATCH/DELETE /v1/feeds/{id}`, `POST /v1/feeds/{id}/refresh`, `POST /v1/refresh-runs`, `GET /v1/refresh-runs/{id}` |
| Episodes | `GET /v1/episodes?feed_id=&after=`, `GET /v1/episodes/{id}` (resume, signed audio URL, transcript id, publisher text, chapters, summary, processing state), `POST /v1/episodes/{id}/audio`, `POST /v1/episodes/{id}/process`, `GET /v1/transcripts/{id}` |
| Video | `POST /v1/episodes/{id}/video` (ask for an episode's video: a feed's own file the server fetches, a YouTube video the home fetcher brings), `PATCH /v1/episodes/{id}` (`youtube_id`), `POST /v1/youtube/episodes` (a pasted YouTube video link becomes an episode of its channel's show, created unfollowed if new, with its video asked for); for the home fetcher (fetcher/README.md): `GET /v1/video/wanted`, `PUT /v1/episodes/{id}/video/file`, `PUT /v1/episodes/{id}/video/captions`, `POST /v1/episodes/{id}/video/done`, `POST /v1/episodes/{id}/video/failed` |
| Playback | `PUT /v1/playback/{asset_id}` |
| Snips | `POST /v1/snips`, `GET /v1/snips`, `GET/PATCH/DELETE /v1/snips/{id}`, `POST /v1/snips/{id}/revoke`, `POST /v1/snips/{id}/restore`, `GET /v1/export/snips.{json,md}` |
| Status | `GET /v1/jobs?subject=` for the "preparing" indicators and the settings page |
| Public | `GET /s/{token}`, `GET /s/{token}.json`, `GET /s/{token}/r{rev}.mp3` |
| Media | `GET /m/assets/{asset_id}` (signed), `GET /m/clips/{revision_id}` (signed, owner preview) |

Clients learn about progress by polling `GET /v1/snips/{id}` with `If-None-Match` every two seconds while a revision is not ready. Server-sent events can be added on the web later; polling is the behaviour that works identically in a backgrounded native app and a browser tab, and the load is a few requests per snip.

## Decisions that matter for iOS

| Decision made now | What it buys the native app |
| --- | --- |
| Bearer device tokens; the web cookie is just a transport for the same token | The app stores one token in the Keychain and sends one header. No cookie jar, no CSRF dance |
| Signed, expiring media URLs instead of authenticated media routes | `AVPlayer`, `AVAssetDownloadTask`, and `URLSession` background downloads work with a plain URL. No custom header plumbing |
| Source audio served as stored (MP3/AAC); clips always MP3 | AVFoundation decodes both natively. Nothing is Opus or WebM |
| Every write is idempotent: `client_request_id` on snips, `seq` on playback | An offline outbox replays safely after a flight; the same code path handles a flaky tunnel |
| A snip is one POST with four fields | A headphone gesture through `MPRemoteCommandCenter` can create a snip with no UI and no local state beyond the player engine |
| `heard_from_ms` is computed by the player engine, not the server | The engine contract is documented in [01-playback.md](01-playback.md) and is the one piece the native app must reimplement faithfully |
| Transcript JSON is compact, versioned, and immutable | A `Codable` struct, cached on disk per transcript id, usable offline |
| Public pages live on the app's hostname with path tokens | An `apple-app-site-association` file on that host turns every shared link into a universal link that opens the app when installed |
| OpenAPI generated from route schemas | Apple's `swift-openapi-generator` produces the client; the web app uses the same document for its TypeScript types |
| All AI and rendering stays server-side | The app ships no models and no provider keys; the App Store build is a player |
| Status by polling with ETags | Works when backgrounded; APNs push for "your snip is ready" is an optional later addition, not a dependency |
| Timezone stored on the server for the daily refresh | The app does not run schedules; it only shows the last run |
| Type is sized relative to the system text size from a larger default, never in fixed pixels | SwiftUI declares each style with `Font.custom(_:size:relativeTo:)` and control sizes with `@ScaledMetric`, so Dynamic Type scales one layout through the accessibility sizes. The web app uses `rem` on a root set to `font: -apple-system-body`, so iPhone Safari follows the same setting and desktop browsers follow their own |

Things not to do because of iOS: do not rely on web-only audio formats, do not put business rules in the React code that the native app would have to copy, do not make the transcript shape depend on a JavaScript library's output, and do not use a separate public domain unless universal links are ruled out.

## Deliberately not built

A separate worker language (Python stays optional and only for the local Whisper adapter), a message broker, an ORM with lazy loading, server-side rendering of the owner app, WebSockets, a CDN, and multi-tenancy. Each is a day of work when it is needed and a week of friction if added now.
