# The App Store version: Snip without a server

A plan for a build of the iOS app that friends can install from the App Store. They have no server, so everything
is stored on the phone, transcription runs on the phone, and the model steps (snip titles and summaries, episode
summaries) are paid for by their own ChatGPT plan. The owner's build keeps talking to their server; both are one app.

Status: tests run 2026-11-25 (below). Step 1 is in: `ios/Packages/OnDevice` and the app's on-phone mode
(`AppModel.usePhone`). Not yet in it: background refresh of feeds while the app is closed, the share sheet, and
the Live Activity's Snip button, which still shows and does nothing.

## What a friend gets, in order

1. **A podcast app on the phone**: add shows, episodes, playback, Up Next. No account and no AI.
2. **Transcripts on the phone** and Skip ad.
3. **Snips**: selection, clip, title and summary, through "Continue with ChatGPT".
4. **App Store submission**: name, privacy page, review notes.

Later, not in this plan: a relay on the owner's server for cloud transcription and for a paid "use my AI" tier
(StoreKit), and public snip links, which need a server.

Left out of the store build because they need the server: public links (`/s/…`), video and YouTube, pasted links,
publisher text and email sources, topic search, the Prompts and eval screens. A snip is shared with the share sheet.

## How it is built: one app, two backends

The app already reaches the server through one type, `APIClient`, and every screen is written against its models.
So the phone answers the same API:

- `PodcastAPI.HTTPTransport` is what `APIClient` sends a request through. `URLSession` is one; `OnDevice.LocalBackend`
  is the other. It routes the same paths (`/v1/feeds`, `/v1/episodes`, `/v1/queue`, `/v1/playback/{id}` …) to an
  SQLite file on the phone and returns the same JSON, so `contracts/api/` and `DecodeFixturesTests` describe both.
- A route the phone does not have answers 404 with the server's error envelope; the screens that need it are hidden
  in this mode (`AppModel.mode`).
- The phone's tables mirror the server's (`feed`, `episode`, `playback_state`, `up_next`), so its queries are the
  server's queries. A rule that changes on the server changes here too; `server/src/services` stays the reference.
- **Audio is the publisher's file.** `asset.audio_url` is the enclosure URL (or the downloaded file). Once an episode
  is to be transcribed it must be downloaded, and playback must use that same file: inserted ads differ between
  fetches, and every time in a transcript is a position in one file (`docs/core/README.md`).
- **The pure core** (`server/src/core`: sentences, span selection, summary validation, ad detection) has to give the
  same answers on the phone. Two ways, to be decided at step 2: port it to Swift against `contracts/golden/` (the
  cross-repo plan's `snipkit`), or bundle the TypeScript and run it in JavaScriptCore, which cannot drift and keeps
  the evals meaningful for both. Feed parsing is ported to Swift now (`XMLParser`), tested on the server's cases.

## The model steps: the listener's own ChatGPT plan

OpenAI's Sign in with ChatGPT (plan usage, launched 2026-09-29) lets an app spend the signed-in user's ChatGPT plan
on Responses API requests, with no API key.

- **Who may use it without asking OpenAI**: open-source, locally run apps. A paid or hosted app applies through an
  interest form. So the repository needs a license before the store build ships, and the later paid tier needs the
  form. Whether an App Store app counts under the open-source path is OpenAI's call and is not confirmed.
- **Flow**: authorization code with PKCE at `auth.openai.com`; first sign-in sends `client_id=dynamic_agent_client`
  and the callback returns the client id to keep; the redirect must be `http://127.0.0.1:<port>/auth/callback`; scopes
  `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`. Access tokens last an hour, refresh
  tokens 30 days and rotate. Tokens go in the Keychain.
- **Requests**: `POST https://api.openai.com/v1/responses` with `store: false`, `stream: true`, `instructions` rather
  than a system message, and no `temperature` or `max_output_tokens`. JSON-schema output works. Audio input and
  transcription are not offered on this route, which is why transcription is on the phone.
- It fits behind the server's `TextModel` interface (a prompt and a schema in, validated JSON out), so the prompts
  and validators are the server's own.
- **Fallback** if a user has no paid plan or OpenAI refuses the app: their own OpenAI API key, same interface.

## Transcription on the phone

Apple's `SpeechTranscriber` (iOS 26, no download in the app) behind the server's `Transcriber` shape: words with
start and end times. It gives no speaker labels and no music or laughter events. If its accuracy is not enough,
Parakeet (about 600 MB) is the upgrade behind the same interface. Cloud transcription with the owner's key needs the
relay: a key cannot ship inside an App Store app.

## Ads

`core/ads/detect.ts` needs no model, but sponsor phrases alone find few breaks; most come from the `ad` chapters of
the episode summary. So Skip ad is good only once the episode summary runs (step 3), and partial before that.

## Test results, 2026-11-25

Three real episodes (33, 60 and 78 minutes), compared with their stored ElevenLabs transcripts and ad breaks.

| | 33 min, news | 60 min, two hosts | 78 min, comedy interview |
| --- | --- | --- | --- |
| Apple transcription, time on an M-series Mac | 29 s | 53 s | 75 s |
| Words that differ from ElevenLabs | 4.6% | 6.8% | 13.2% |
| Word start times, median difference | 152 ms | 180 ms | 148 ms |
| Ad breaks stored on the server | 4 | 5 | 5 |
| …found from sponsor phrases alone (Apple transcript) | 1 | 0 | 3 |
| …found with the server's summary chapters added | 4 | 5 | 5 |

- About half of what Apple leaves out on the two long episodes is fillers ("uh", "yeah"); in heavy crosstalk it
  dropped eight passages of 8 to 19 words.
- **ChatGPT plan, on the 33-minute episode's Apple transcript**: sign-in and registration worked with no key; a snip
  summary took 6.9 s and passed `validateSnipBullets` first time; the episode summary took 43 s in two calls of about
  10,000 input tokens; ad detection from it found 3 of the 4 stored breaks, each within a second, and missed the
  closing one (labelled outro).
- **The iPhone mechanism**: in the simulator a system sign-in sheet redirected to a listener inside the app on
  `127.0.0.1`, and the app received the callback (with a stand-in page, not OpenAI's).

Not tested: transcription speed and battery on an iPhone; OpenAI's own page inside the app; models other than the
plan's first; languages other than English.

## Decisions for the owner

1. A license for the repository (the open-source sign-in path needs one).
2. Send OpenAI's interest form now, since a paid tier is planned.
3. Swift port or JavaScriptCore for the pure core (step 2).
4. The store name: "Snip" may be taken.
