# 1. Episode playback and retrieval from private RSS feeds

**Contract:** given a subscribed feed, discover its episodes; given an episode, produce one immutable stored recording; given a recording and a device, stream it with seeking and keep a resume position that survives reloads, offline periods, and device switches.

## Pure core

```ts
parseFeed(xml: string, feed: Feed): { feed: FeedMeta; items: FeedItem[] }
   // tolerant RSS 2.0 + iTunes + podcast namespaces; items keyed by guid
diffEpisodes(known: Set<guid>, items: FeedItem[]): { new: FeedItem[]; changed: FeedItem[] }
validateDownload(tmpPath, expected: { bytes?, mime? }): { sha256, bytes, duration_ms, mime } | Rejection
   // ffprobe must decode the whole file; duration comes from the container, bytes must match Content-Length when present
mergePlayback(stored: PlaybackState | null, incoming: PlaybackState): PlaybackState
   // seq guard within one device; most recent updated_at across devices
```

The I/O around them (HTTP fetch, disk moves, SQLite writes) lives in the job handlers `refresh_feed` and `fetch_audio`.

## Feed refresh

1. Fetch with `If-None-Match` and `If-Modified-Since` from the feed row. A 304 ends the job. Follow at most five redirects, re-checking at each hop that the host resolves to a public address. Cap the body at 20 MB. Disable external entities in the XML parser.
2. Private feeds are ordinary feeds whose URL carries a token or basic-auth credential. The URL is encrypted at rest, redacted in logs, and never leaves the server in any response. A 401, 403, or 410 sets `last_error` with a category the UI can show ("credential expired", "feed removed"); the feed stays subscribed.
3. Identify episodes by `(feed_id, guid)`. When a feed omits GUIDs, use the enclosure URL stripped of query strings; when that is also missing, use the item link. Never match on title alone. A changed enclosure URL on a known GUID is recorded but does not touch an existing asset.
4. Insert new episodes with `first_seen_at`, sanitized `description_html`, and the enclosure. For feeds with `auto_process = 1`, enqueue `fetch_audio` for new items at priority 0, newest first, within the storage and transcription budgets in `setting`. Deferred items are visible as deferred, not silently dropped. Feeds with `auto_process = 0` are manual-mode shows: episodes are listed and playable, audio is fetched on first play, and transcription happens only through `POST /v1/episodes/{id}/process` or when a snip needs it.

Refresh is triggered by cron (`POST /v1/refresh-runs`, idempotent per local day) and manually from the app; both enqueue `refresh_feed:<feed_id>` per feed, which deduplicates.

## Audio acquisition

Download to `media/tmp/`, following redirects with the same public-address check (podcast enclosures routinely pass through two or three tracking redirects). Then `validateDownload`: ffprobe must decode it, duration must be present, and the byte count must match `Content-Length` when the server sent one. Compute SHA-256, move the file to `media/assets/<sha256>.<ext>`, insert `audio_asset`, and set `episode.current_asset_id` if the episode has none. A failed or truncated download leaves no asset.

Playback requires a completed asset. Servers download a 100 MB episode in seconds, so an un-fetched episode shows "Preparing" for a moment rather than streaming through the server. This keeps the invariant that every timestamp refers to bytes on disk, which is the whole reason dynamic ad insertion cannot shift a snip.

If a later fetch of the same enclosure yields a different checksum, that is a new asset. The episode's pointer moves to it only if no snips reference the old one; otherwise the old asset stays current and pinned.

## Serving audio

Media is served from **signed URLs**, not cookie- or header-authenticated routes:

```text
GET /m/a/{asset_id}?e=<expiry unix s>&s=<hmac-sha256(asset_id|e|device_id)>
```

The API returns the URL inside the episode response, valid for 24 hours. The media handler verifies the signature, then serves the file with `Accept-Ranges`, correct `Content-Range` for any byte range, strong `ETag` (the checksum), and `Cache-Control: private, max-age=86400`. This one decision is what lets a `<audio>` element, `AVPlayer`, and a `URLSession` background download all play the same file without custom headers.

Serve the source file as stored. No transcoding for playback: MP3 and AAC enclosures cover essentially every podcast and play natively in Safari and AVFoundation. If a feed ever delivers something else, convert once at acquisition time and store the converted file as the asset so there is still exactly one timeline.

## Resume and playback state

The client reports state with `PUT /v1/playback/{asset_id}`:

```json
{ "position_ms": 1122000, "speed": 1.5, "playing": true, "finished": false, "seq": 418 }
```

Reports go out every 15 seconds while playing and immediately on pause, seek, backgrounding, and unload. `seq` is a per-device counter persisted locally, so an offline queue replays in order and a stale report cannot overwrite a newer one. The episode response includes `resume: { position_ms, device_name, updated_at }`, the most recent non-finished state across devices. Deliberate rewinds are respected because the rule is "most recent", not "furthest". Clip preview playback on the snip card never reports playback state.

`finished` is set explicitly by the client when playback reaches the end or the owner marks it played. It is never inferred from position.

## The player engine

A small state machine shared in design, though not in code, by the web app and the native app:

```text
state:  asset_id, position_ms, speed, playing, heard ranges, seq
events: load(asset) → position = resume or 0; heard = the 180 s before a resume point (none from 0)
        play / pause   → heard unchanged (a pause does not break continuity in asset time)
        seek(to)       → close the current heard stretch; a new one starts at `to`
        tick           → position advances by real elapsed time × speed; a jump the clock cannot explain
                         (back > 1 s, or forward > elapsed × speed + 3 s) counts as a seek nobody announced
        ended          → finished = true
        snip()         → POST /v1/snips { client_request_id, asset_id, anchor_ms: position,
                         heard_from_ms: start of the merged heard stretch containing position }
```

Heard audio is kept as merged intervals (stretches under 2 s apart join), not a single "heard since the last seek" point: skipping back 15 s inside audio already played keeps the whole stretch, and skipping forward past unheard audio starts a new one. The reference is `web/src/player/heard.ts`; `contracts/golden/heard/heard_v1.json` holds the cases a native port must reproduce.

`heard_from_ms` is the only thing the server cannot compute itself, and it is what stops a snip from reaching back across a seek into audio that was never heard. On the web the engine wraps a single `<audio>` element plus the Media Session API for lock-screen controls. On iOS it wraps `AVPlayer`, `MPNowPlayingInfoCenter`, and `MPRemoteCommandCenter`, which is also where a headphone gesture becomes `snip()`.

Transcript and chapters come from `GET /v1/transcripts/{id}` and the episode's summary (see the data model shapes). The client follows the transcript by binary-searching the current position in the segment list; nothing about following is server work.

## Known risk: web audio on iPhone

Background playback and lock-screen controls in a Home Screen web app are the least reliable part of the plan and are outside this spec's control. The milestone 0 device test in [delivery.md](../delivery.md) decides whether the native player comes forward. Nothing above changes in either case; the API and the engine contract are the same.

## Evals

Invariants (unit tests):

- `parseFeed` never throws on malformed input; items without any usable identity are reported, not merged.
- `validateDownload` rejects a truncated file, a file whose bytes disagree with `Content-Length`, and a non-audio file.
- `mergePlayback` ignores a lower `seq` from the same device and prefers the newest `updated_at` across devices.
- Range handling: for every `(start, end)` in a sample, the served bytes equal the file slice, and an unsatisfiable range returns 416.

Fixtures (`evals/playback/cases/`):

- Six real feeds saved as XML: two public, two private with credentials stripped and re-templated, one with missing GUIDs, one with a redirect chain. Expected: episode counts, identities, and the diff after a second fetch with one new item.
- Three enclosures: an MP3, an AAC in M4A, and a file behind three redirects. Expected: checksum stable across two downloads, duration within 0.5% of ffprobe.

Judged (manual device checklist, repeated on each release): time to first audio for a new episode under 10 seconds; resume within 2 seconds of where listening stopped after a reload, after an hour offline, and from a second device; a 30-minute locked-screen session with AirPods, one incoming call, and one Bluetooth route change.
