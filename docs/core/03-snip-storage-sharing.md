# 3. Snip storage and sharing

**Contract:** given a selection on an asset, produce an immutable revision that contains a standalone audio clip, the exact excerpt, and (once function 5 has run) a title and summary; make the snip's stable public URL serve exactly that revision and nothing else; let the owner edit, revoke, restore, delete, search, and export. The public side must be impossible to use as a window into the parent recording.

## Pure core

```ts
clipArgs(asset: AudioAsset, start_ms: number, end_ms: number, out: string): string[]
   // the exact ffmpeg argv; pure so the eval can assert on it
verifyClip(probe: FfprobeResult, expected_ms: number): Ok | Rejection   // |measured − expected| ≤ 250 ms
materializeExcerpt(transcript: Transcript, start_word: number, end_word: number): string
publicView(snip: Snip, revision: SnipRevision | null, rev_requested?: number):
   | { kind: 'ready', ... whitelisted fields ... }
   | { kind: 'preparing' } | { kind: 'gone' } | { kind: 'not_found' }
```

## Lifecycle of a revision

```text
POST /v1/snips ──► snip + revision 1 (selecting) ──► select_snip job
                                                       │
                       ┌───────────────────────────────┘
                       ▼
            revision: start/end/words/excerpt set, status = preparing
                       │
          ┌────────────┴────────────┐
          ▼                         ▼
    render_clip job           summarize_snip job
          └────────────┬────────────┘
                       ▼
              both done → status = ready → public URL serves it
```

`POST /v1/snips` is idempotent on `client_request_id` and returns within 100 ms with the snip id and share URL, because the share token is allocated before any work starts. The owner can copy the link while the page still says "preparing".

A boundary edit creates revision `n+1` in `preparing` and immediately moves `snip.current_revision_id` to it. From that moment the public URL shows "preparing" until the new clip, excerpt, and summary all exist, so audio and text are never published mismatched. Jobs carry their `revision_id`; a job finishing for a revision that is no longer current writes its result and does nothing else. No job can promote a revision to public.

## Rendering the clip

```text
ffmpeg -nostdin -hide_banner -loglevel error
  -ss {start_s} -i {asset_path} -t {duration_s}
  -map_metadata -1 -map_chapters -1 -vn
  -af afade=t=in:st=0:d=0.03,afade=t=out:st={duration_s - 0.03}:d=0.03
  -c:a libmp3lame -b:a 128k -ar 44100
  -f mp3 {tmp_path}
```

Input seeking with `-ss` before `-i` is accurate when transcoding: ffmpeg decodes from the preceding frame and discards up to the requested time. Duration goes through `-t`, not `-to`, because `-to` is interpreted relative to the seeked input and is a classic source of off-by-start bugs. Metadata and chapters are stripped so the clip carries nothing from the parent file. Output is always MP3 at 128 kbps, mono or stereo matching the source, so one format plays in every browser, in link previews, and in `AVPlayer`. The 30 ms fades remove clicks at word boundaries.

After encoding, `ffprobe` must report a duration within 250 ms of `end_ms − start_ms`. The file is then hashed and renamed atomically to `media/clips/<revision_id>.mp3`. Rendering a 90-second clip from a two-hour MP3 takes about a second on the inspected host.

## Public routes

| Route | Serves | Cache |
| --- | --- | --- |
| `GET /s/{token}` | Server-rendered HTML: title, summary, excerpt, show and episode titles, a native `<audio controls>` element, duration, `og:` tags | `no-store` |
| `GET /s/{token}/r{rev}.mp3` | The clip for the current revision, only when `rev` equals the current revision number | `public, max-age=31536000, immutable` |
| `GET /s/{token}/r{rev}.mp4`, `.jpg` | The clip with its picture and its poster, for a snip cut from a video, under the same rule. `render_video_clip` cuts them after the MP3 and never holds the revision back; until then, or with no video on disk, the page plays the MP3. When they exist the page uses a native `<video controls playsinline>` and adds `og:video` | `public, max-age=31536000, immutable` |
| `GET /s/{token}.json` | The same whitelisted fields as the page, for native clients and embeds | `no-store` |
| `GET /e/{token}` | The episode page: every snip of one episode that `/s/{token}` would serve, in episode order, with a bottom player (see below) | `no-store` |
| `GET /e/{token}.json` | The same list as JSON | `no-store` |

States: snip active and current revision ready → 200. Active but not ready → 200 "preparing" page with `<meta http-equiv="refresh" content="5">`, and 202 for the JSON route. Revoked or deleted → 410. Unknown token → 404, same latency as a 410 so tokens cannot be probed by timing.

Every public response carries `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer`, and a Content-Security-Policy that allows only same-origin. There is no search, and a single snip's page has no next/previous navigation. The one list is the episode page, which exists only after the owner shares that episode. Pages are a few kilobytes of HTML with no framework; a dozen lines of inline script highlight the excerpt as the clip plays, and the page works with script disabled.

Link previews use `og:title` (snip title), `og:description` (summary, falling back to the first 200 characters of the excerpt), `og:audio` (the immutable clip URL), and `og:image`. For a private feed, `og:image` is a server-cached copy of the artwork or the app's default image, never a hotlink to a credentialed URL.

The whitelist for the page and the JSON is the complete list of fields a recipient can see: `title`, `summary`, `excerpt`, `duration_ms`, `clip_url`, `video` (its URL, poster and size, or null), `created_at`, `episode.title`, `show.title`, `show.site_url` (public feeds only), and `episode.public_url` (public feeds only). Nothing else is serialized, which is enforced by building the public view from a typed struct rather than from the database row.

## Episode pages

The owner can share every snip of an episode as one page, `/e/{token}`, added October 23, 2026. It has its own token, one per episode (`episode_share`), created by `POST /v1/episodes/{id}/share` (idempotent; reactivates a revoked link) and withdrawn by `POST /v1/episodes/{id}/share/revoke`, after which it returns 410 like a revoked snip. Withdrawing the page leaves each snip's own link alone.

The list is read when the page is opened: every snip of the episode that is active and whose current revision is ready, ordered by where it starts. Snips made later appear without a new link; revoking or deleting a snip removes it from the page; a snip being edited drops off until its new revision is ready. Each item is built from the same whitelisted public view as `/s/{token}`, plus `start_ms` (where the snip starts in the episode, shown as "from 31:55"). Clip and page links in the HTML are relative paths, so the page works on whatever host serves it.

The page is server-rendered HTML. With script, a Spotify-style player docks at the bottom: it plays one snip at a time and moves on to the next when a clip ends, with previous (restart if more than 3 s in), play/pause, next, a scrubber, and speed (1, 1.25, 1.5, 2×), mirrored on the lock screen through Media Session. "Play all" starts from the first snip. Each row shares that snip's own `/s/{token}` link (the system share sheet over HTTPS, else copy), and the header shares the page. The script is inline and allowed by a per-response nonce in `script-src`; nothing else may run. Without script, each snip shows a native `<audio controls>` and links to its own page.

In the app, the episode's snip list has "Share all", which opens the share sheet for an existing page, or creates the page and copies its link. The row beside it opens the page or stops sharing it.

## Owner routes

| Route | Behaviour |
| --- | --- |
| `POST /v1/snips` | Create; idempotent on `client_request_id`; returns snip with share URL |
| `GET /v1/snips?asset_id=&q=&after=` | Owner library; `q` searches title, summary, excerpt, and note through FTS5 |
| `GET /v1/snips/{id}` | Snip with its current revision |
| `PATCH /v1/snips/{id}` | Boundary edit (new revision), `note`, or `title` override. A boundary edit requires `if_revision` matching the current revision id (400 without it, 409 on a mismatch); word-index edits also send `transcript_id`. Title and note edits apply in place and may omit `if_revision` |
| `POST /v1/snips/{id}/revoke`, `/restore` | Revocation is sticky: edits and retries never republish a revoked snip. Restore is a deliberate action |
| `DELETE /v1/snips/{id}` | Soft delete; public URL becomes 410; clips are removed after 30 days |
| `GET /v1/snips/{id}/clip` | Signed clip URL for in-app preview; preview never reports playback state |
| `GET /v1/episodes/{id}/share`, `POST .../share`, `POST .../share/revoke` | The episode page: read (null if never shared), share (idempotent, reactivates), withdraw |
| `GET /v1/export/snips.json`, `.md` | Everything the owner wrote or generated, with provenance; the Markdown form is one section per snip with the link, excerpt, summary, and note |

Storage: a clip per revision, so an edited snip keeps its history. Non-current revision clips older than seven days are deleted; the revision rows stay. The parent asset is pinned by the first snip and stays pinned for as long as any snip references it, so timestamp editing keeps working years later.

## Evals

Invariants (unit tests):

- `clipArgs` always includes `-map_metadata -1`, `-map_chapters -1`, uses `-t` not `-to`, and never references anything but the one asset path.
- `publicView` for a revoked, deleted, not-ready, or non-current revision contains no `clip_url`, no excerpt, and no summary. A snapshot test pins the exact set of keys the ready view may contain.
- The media handler rejects any `rev` other than the current one and any path that is not `/s/{token}/r{rev}.mp3` (or `.mp4`, `.jpg`); there is no route that takes an asset id or a time range from the public side.

Fixtures (`evals/snip-sharing/`):

- **Containment.** A synthetic recording with three spoken markers, "ALPHA" before the span, "BRAVO" inside it, and "CHARLIE" after it. Create a snip on the span, then transcribe the public clip with the `Transcriber`: the text must contain BRAVO and must not contain ALPHA or CHARLIE. Fetch the public HTML and JSON: neither may contain ALPHA or CHARLIE. Send crafted `Range` requests before byte 0 and past the end of the clip: only clip bytes are ever returned.
- **Boundary accuracy.** For 20 real snips, the rendered duration is within 250 ms of the requested span, and the transcription of the clip starts and ends with the first and last words of the excerpt in at least 95% of cases.
- **Revision race.** Start an edit while revision 1 is still rendering; revision 1's render completes last. The public URL must show "preparing" throughout and then serve revision 2 only.
- **Revocation.** Revoke, then retry every pending job for that snip, then edit: the public routes return 410 at every step.

Judged: paste a link into iMessage, Slack, and a tweet composer and confirm the preview shows the title, summary, and plays the audio where the client supports `og:audio`. Time to first byte on the public page under 200 ms from outside the Tailnet.
