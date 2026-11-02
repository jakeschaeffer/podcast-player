# server

The API, the background worker, and the core functions, in one TypeScript package. The design is in [docs/core](../docs/core/README.md); this file is how to run it.

## Run

Requirements: Node 22, pnpm, `ffmpeg` and `ffprobe` on the path. Configuration lives in `../.env.local` (gitignored); `pnpm dev` loads it.

```bash
pnpm install
pnpm dev            # API on 127.0.0.1:8080 plus the worker, in one process
pnpm dev:api        # API only
pnpm dev:worker     # worker only (jobs, scheduled feed refresh, clip pruning)
pnpm test           # unit and integration tests; no network, no API keys needed
pnpm typecheck
pnpm build && pnpm start
```

In production the server runs as a systemd service behind nginx (`../deploy/README.md` is one working setup, and [../docs/SELF-HOSTING.md](../docs/SELF-HOSTING.md) the guide); stop it before running `pnpm dev` on that host, since both use port 8080.

| Variable | Meaning | Default |
| --- | --- | --- |
| `APP_SECRET` | Derives the encryption key for feed URLs and the signing key for media URLs. Changing it orphans stored feeds. | required |
| `OWNER_PASSWORD` | Mints device tokens through `POST /v1/devices` | required |
| `ELEVENLABS_API_KEY` | Enables the Scribe v2 transcriber; without it transcription jobs are deferred | – |
| `TEXT_MODEL` | `none` or `codex-cli`. With `none`, snip summaries are skipped (the excerpt publishes with a derived title) and episode summaries are deferred | `none` |
| `CODEX_MODEL` | Model name passed to `codex exec` when `TEXT_MODEL=codex-cli` | CLI default |
| `CODEX_REASONING_EFFORT` | `low`, `medium`, or `high` for Codex calls | CLI default |
| `SELECTION_MODEL` | `on` lets the text model adjust snip starts; off keeps selection deterministic (the measured default) | `off` |
| `PUBLIC_BASE_URL` | Origin used in share and media URLs (`https://snip.example.com` in production). The login cookie's `Secure` flag follows the request's scheme, not this value | `http://127.0.0.1:PORT` |
| `SHARE_BY_NAME` | The name on share cards and public pages ("10 clips from Jake"); empty leaves just the count | empty |
| `DATA_DIR` | Holds `app.db` and `media/` | `./data` |
| `HOST`, `PORT` | Listen address | `127.0.0.1`, `8080` |
| `REFRESH_INTERVAL_MINUTES` | How often the worker refreshes every feed; `0` disables (use cron with `POST /v1/refresh-runs`) | `30` |
| `TRANSCRIPTION_BUDGET_MINUTES` | Monthly cap on catalog (priority 0) transcription; owner-triggered work ignores it | `6000` |
| `TRANSCRIPTION_CENTS_PER_HOUR` | Rate used for the cost ledger | `22` |
| `MEDIA_URL_TTL_SECONDS` | Lifetime of signed audio URLs | `86400` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | A Desktop OAuth client from the Google Cloud console, for read-only Gmail access to the mailbox that receives publisher emails | – |
| `GOOGLE_REFRESH_TOKEN` | Written by `pnpm gmail:auth`; scope `gmail.readonly` only | – |
| `EMAIL_SOURCE_QUERY` | Gmail search for newsletters that carry episode text; empty disables the email source (text feeds are the default path) | empty |
| `TEXT_PREFERRED_KINDS` | Episode kinds whose publisher-text transcript becomes the current one; ASR stays current for the rest. `pnpm text:policy` re-applies it to existing recordings | `update,article` |
| `PODCASTINDEX_KEY`, `PODCASTINDEX_SECRET` | Use Podcast Index for `GET /v1/search/shows` instead of the keyless iTunes Search API | – |
| `GIT_AUTO_PUSH` | `1` pushes the server's own commits (Prompts screen versions and activations, eval scorecards) to origin as soon as they are made. Set only in production | off |

## First use

```bash
# 1. a device token (shown once)
curl -s -X POST localhost:8080/v1/devices -H 'content-type: application/json' \
  -d '{"name":"laptop","platform":"cli","password":"<OWNER_PASSWORD>"}'

# 2. subscribe; private feeds carry their credential in the URL and are stored encrypted
curl -s -X POST localhost:8080/v1/feeds -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"url":"https://example.com/feed.xml","backfill":2}'
```

The worker refreshes the feed, fetches the newest `backfill` episodes, transcribes them, and from then on processes every new episode as the feed publishes it. `GET /v1/episodes` shows per-episode processing state; `GET /v1/jobs` shows the queue.

**Automatic versus manual shows.** `auto_process` (default true) decides whether a show's new episodes are fetched, transcribed, aligned, and summarized on their own. With `auto_process: false` a show is listed and playable, but nothing is transcribed until you ask: `POST /v1/episodes/{id}/process` runs the whole pipeline for one episode at owner priority (audio if missing, ASR transcript, alignment of any publisher text, summary) and the episode's `processing` block reports each step until `transcript`, `text`, and `summary` read `ready`. Creating a snip on an untranscribed episode also triggers its transcription, because the snip needs it. Find shows with `GET /v1/search/shows?q=`, which uses the keyless iTunes Search API (or Podcast Index when its key is configured) and marks results you already subscribe to.

**Which transcript is current.** A recording can hold an ASR transcript and one aligned from publisher text. `TEXT_PREFERRED_KINDS` (default `update,article`) names the episode kinds whose publisher-text transcript is exposed as current; everything else, including interviews whose published text is edited, stays on ASR. `GET /v1/episodes/{id}` returns `chapters` from the publisher's sections when the text is aligned, else from the model's episode summary.

## API

The OpenAPI document is generated from the route schemas and served at `GET /v1/openapi.json` (device token required). A copy is committed as `server/openapi.json`, the contract the web client's types and the native app are built from; `test/openapi.test.ts` fails when it is stale, and `pnpm openapi:update` rewrites it. Summary:

| Area | Routes |
| --- | --- |
| Auth | `POST /v1/devices` (login, no auth), `GET /v1/devices`, `DELETE /v1/devices/{id}` |
| Feeds | `GET /v1/search/shows?q=` (find public shows; returns feed URLs), `GET/POST /v1/feeds` (podcast feeds, and text feeds attached with `kind: "text"` and `text_for_feed_id`), `GET/PATCH/DELETE /v1/feeds/{id}`, `POST /v1/feeds/{id}/refresh`, `POST /v1/refresh-runs` (idempotent per key), `GET /v1/refresh-runs/{id}` |
| Episodes | `GET /v1/episodes?feed_id&after&limit`, `GET /v1/episodes/{id}` (signed audio URL, resume, transcript id, publisher text and chapters, summary, suspected ad breaks, processing state), `POST /v1/episodes/{id}/audio` (fetch the recording now), `POST /v1/episodes/{id}/process` (the whole pipeline now, for manual-mode shows), `GET /v1/transcripts/{id}` |
| Video | `POST /v1/episodes/{id}/video` (ask for an episode's video: a feed's own file the server fetches, a YouTube video the home fetcher brings), `PATCH /v1/episodes/{id}` (`youtube_id`), `POST /v1/youtube/episodes` (a pasted YouTube video link becomes an episode of its channel's show, created unfollowed if new, with its video asked for), `POST /v1/links/episodes` (a pasted link to a video or audio file becomes a one-off episode of the "Pasted links" show, `kind: "links"`, which the server downloads and transcribes; a web page is refused); for the home fetcher (fetcher/README.md): `GET /v1/video/wanted`, `PUT /v1/episodes/{id}/video/file`, `PUT /v1/episodes/{id}/video/captions`, `POST /v1/episodes/{id}/video/done`, `POST /v1/episodes/{id}/video/failed` |
| Playback | `PUT /v1/playback/{asset_id}` with a per-device `seq` |
| Snips | `POST /v1/snips` (idempotent on `client_request_id`; returns the share URL at once), `GET /v1/snips?q&asset_id&episode_id`, `GET/PATCH/DELETE /v1/snips/{id}`, `POST /v1/snips/{id}/revoke`, `POST /v1/snips/{id}/restore`, `GET /v1/export/snips.json`, `GET /v1/export/snips.md` |
| Jobs | `GET /v1/health`, `GET /v1/jobs?subject&status&kind`, `POST /v1/jobs/{id}/retry` |
| Media | `GET /m/assets/{asset_id}` and `GET /m/clips/{revision_id}`, signed with `e` (expiry), `d` (device), `s` (signature); Range supported |
| Public | `GET /s/{token}` (HTML), `GET /s/{token}.json`, `GET /s/{token}/r{rev}.mp3` (current revision only) |

All `/v1` routes except login take `Authorization: Bearer <token>` or the `pp_device` cookie set by login with `set_cookie: true`.

## How a snip flows

1. `POST /v1/snips` stores the tap and allocates the public link. Revision 1 starts as `selecting` (or `waiting` if the asset has no transcript yet, which also queues transcription at top priority).
2. `select_snip` picks the span: sentences in the heard window, scored heuristically, optionally confirmed by the text model. Writes the exact excerpt.
3. `render_clip` cuts an MP3 with ffmpeg and verifies its duration; `render_video_clip` also cuts an MP4 and a poster when the recording has its video on disk, without holding anything up; `summarize_snip` writes a title and summary (or a derived title when no model is configured).
4. The revision becomes `ready` and `/s/{token}` serves it. Edits create a new revision and the page shows "preparing" until the new clip and text exist together. Revocation is sticky.

## Layout

```text
src/core/           pure functions, no I/O
  feed/             RSS parsing (podcast items and text items)
  transcript/       normalization, word slicing, token normalization, shared types
  snip/             sentencizer and span selection
  clip/             ffmpeg arguments and verified rendering
  summary/          snip and episode summarization, prompts, the invented-name guard
  ads/              ad-break detection from transcripts and chapters
src/adapters/       the outside world behind interfaces: Transcriber (ElevenLabs), ForcedAligner, TextModel (Codex CLI), ShowSearch (iTunes, Podcast Index)
src/services/       database-backed operations, one file per area
  feeds.ts          subscriptions and refresh (podcast feeds; text feeds dispatch to publisherText.ts)
  episodes.ts       episode views, audio fetch, processing state and the on-demand pipeline
  transcripts.ts    storing and loading transcripts, the ASR job
  publisherText.ts  publisher text: text-feed refresh, article storage, forced alignment job
  emailSource.ts    the optional Gmail variant of the above
  textPolicy.ts     which transcript is current per episode kind
  adBreaks.ts       stored ad breaks per recording, the detect_ads job
  snips.ts          owner-facing snips: create, edit, list, revoke
  snipJobs.ts       the snip pipeline: select, render, summarize
  publicSnips.ts    what a recipient may see and play
  playback.ts, media.ts, summaries.ts, titleMatch.ts, spanPicker.ts
src/jobs/           SQLite job queue, worker loop, handler map keyed by job kind
src/http/           Fastify composition root, auth, TypeBox schemas (the OpenAPI contract), one route module per area, public page renderer
src/db/             migrations and typed rows
src/cli/            transcribe, drain, text-policy, ads, email-sync, gmail-auth, gmail-check
src/evals/          case builders and runners for the eval folders at the repository root
prompts/            the production prompts, one file per version, and registry.json naming the active one; its README indexes every AI workflow
test/               helpers and the end-to-end integration test
```

## Tools

```bash
pnpm transcribe path/to/episode.mp3 --language eng        # one file through Scribe v2 into evals/transcription/fixtures
pnpm transcribe --from-raw evals/transcription/fixtures/x.elevenlabs.json   # re-normalize a saved response, no API call
pnpm drain                                                 # run every queued job to completion and exit
pnpm ads --feed Stratechery --limit 10                     # the ad breaks found in recent episodes, with their words; reads the database only
pnpm gmail:auth                                            # optional email source: print the one-time consent URL; then --redirect "<landing url>" stores the refresh token
pnpm gmail:check --query "from:stratechery.com newer_than:14d"   # optional email source: confirm read access and inspect the emails
pnpm email:sync                                            # optional email source: fetch, match, and queue alignment by hand
```

### Ad breaks

`GET /v1/episodes/{id}` carries `ad_breaks`: suspected ads as milliseconds on the asset, for a "Skip ad" button that shows only while one plays and seeks to `end_ms` (never an automatic skip). `src/core/ads/detect.ts` finds them without a model call. Where publisher text was aligned, an ad is speech the article does not have: a run of at least 20 s of ASR words with no counterpart in the text, which gives exact edges. In verbatim text (Updates and Articles) a run of 45 s or more counts on its own; in an Interview's edited transcript it also needs a sponsor phrase or an `ad` chapter. Stratechery prints its sponsor read in the article as well, so a read shows no gap; there a sponsor phrase ("this update is presented by", "brought to you by", "promo code") opens a break that ends at a "back to the update" line, a music sting, or a long pause. The summary's `ad` chapters count too. Overlapping signals merge into one break, edged by the most exact of them, and a break is `high` confidence when two agree.

The `detect_ads` job is free and quick. It runs whenever a transcript or summary lands, and recordings processed before it existed are queued the first time their episode is opened. Results live in `ad_detection`, one row per recording, recomputed when an input or `AD_DETECTOR_VERSION` changes. `pnpm ads` prints what the detector finds, with the words inside each break, so the rules can be checked by reading.

### Publisher text as a content source

Some publishers put the full text of each episode in a second RSS feed (Stratechery's Passport "rss" feed beside its "podcast" feed). Attach it as a **text feed** and the worker does the rest:

```bash
curl -s -X POST localhost:8080/v1/feeds -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"url":"https://example.com/feed/rss/<token>","kind":"text","text_for_feed_id":"<podcast feed id>"}'
```

On every refresh, each new item is matched to an episode of the companion podcast feed by title and date, its article body is extracted into `episode_text` (the preamble the podcast reads, section headings, paragraphs, quoted blocks, speaker prefixes in interviews; summary line and footers dropped; the kind is inferred from the content), and an `align_text` job sends the text plus the stored audio to ElevenLabs forced alignment. The result is a second transcript on the recording with `source = 'rss'`, the publisher's speaker names kept, and section start times written back to `episode_text.sections`. Text that arrives before the audio is aligned once the audio lands; one alignment per recording is kept even if several text sources exist. `GET /v1/episodes/{id}` shows the text under `text` with its sections and the aligned transcript id. `pnpm eval:text:compare` scores aligned text against the ASR transcript of the same recording.

**Email as an alternative source.** When there is no text feed but the publisher emails the text, the same pipeline can read a Gmail mailbox (read-only OAuth): set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from a Desktop OAuth client, run `pnpm gmail:auth` once to store a refresh token, and set `EMAIL_SOURCE_QUERY` (for example `from:stratechery.com`) to turn the `sync_email` job on. It is off by default.
