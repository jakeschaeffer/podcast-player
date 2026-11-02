# Product and screen flows

This is a listening app with an unusually good memory. Its success depends on how easily a listener can capture a thought without interrupting the episode, return to it, and send someone a link that immediately plays the relevant section.

## The everyday flow

1. A server cron routine refreshes the saved subscriptions. Newly discovered episodes appear in the library while local transcription and Codex subscription analysis prepare transcripts and chapters.
2. The listener opens **Today**, resumes an episode or chooses a new one, and can see whether its AI features are ready.
3. The full player offers chapter navigation, a following transcript, and a prominent **Snip** button within thumb reach.
4. Tapping Snip immediately saves the playback position and briefly acknowledges the capture. Listening continues.
5. The server selects the relevant segment, produces its recording, extracts its transcript, writes a segment-specific summary, and automatically publishes a stable link.
6. A compact result card shows the selected range, duration, summary, clip play button, **Edit**, and **Copy link**. Copying a link distributes an already published snip.
7. At the end of the episode, **Share episode** creates a page with the episode identity, selected snips, and an optional personal note. The listener can also create this page from listening history.

## Navigation and screens

Use three main destinations: **Today**, **Library**, and **Snips**. Settings sit behind the profile button; a persistent mini-player remains above bottom navigation.

| Screen | Content and primary interaction |
| --- | --- |
| Today | Continue listening, queue, new episodes, short episode previews, and a small refresh-status indicator |
| Library | Subscribed shows, episode lists, played/unplayed filters, search, Add RSS, and import |
| Episode | Artwork, title, show, duration, description, short summary, chapters, and saved snips |
| Full player | Scrubber, play/pause, skip controls, speed, sleep timer, large Snip action; switch between Chapters and Transcript |
| Snips | Searchable cards grouped by episode or date, with summary, transcript excerpt, duration, publication status, play, edit, and copy link |
| Snip editor | Transcript selection, start/end handles, numeric timestamps, ±1s and ±5s adjustments, preview, editable title/summary |
| Episode share composer | Select existing snips, reorder them, add an optional note, and copy an episode-level link |
| Public snip page | Fast-loading clip player, summary, exact selected transcript, episode attribution, and a public publisher link when available; no login required |
| Public episode page | Episode metadata plus explicitly selected snips and optional note; public-source listening link where available |
| Settings | Subscriptions, refresh schedule status, processing budget, AI providers, retention, exports, and automation credentials |

The player should visually prioritize **Play** and **Snip**. Chapter and transcript views must remain usable with one hand; the result of a snip should not take over the screen. A compact expandable sheet works well for checking a capture and returning to listening.

```text
NOW PLAYING                          ···
[ Episode artwork ]
Episode title
Show name

18:42 ━━━━━━━━━●━━━━━━━━━━━━━━ 57:18
          -15    Play    +30
              [ SNIP ]
           1.5×        Sleep

[ Chapters ] [ Transcript ]
14:20  Why the first approach failed
18:05  A different way to test demand   ← current
24:50  What happened next

Saved · Preparing public clip
18:02–18:39 · 37 seconds
[ Play ] [ Edit ] [ Copy link ]
```

The example titles and times above are illustrative, not taken from a real episode. The final action becomes **Public link ready** when all artifacts are published. A pending link may show a generic preparation page until then.

## Snipping behavior

**Automatic selection:** choose one contiguous idea within the preceding 180 seconds of source audio, usually 30–180 seconds long. Prefer a complete explanation or exchange ending close to the tap, while allowing a short reaction delay. The AI proposes boundaries using transcript word IDs; the server computes and validates the timestamps.

**Inference timing:** prepare episode transcripts and chapters in the daily pipeline. A ready episode only needs a small clip-specific request for boundaries and its summary, followed by audio rendering. An exact precomputed span can reuse its summary; arbitrary edited ranges need a newly matching summary. See the [Codex routine decision](codex-routines.md). Captures from episodes still awaiting a transcript remain queued until preparation finishes by default.

**No future audio by default:** a tap cannot capture speech that has not yet played. If the listener taps midway through a sentence, use the latest coherent boundary where possible. Capturing the rest of the sentence can be explored later as a distinct behavior.

**Short exceptions:** during the first 30 seconds of an episode, or just after a seek with fewer than 30 seconds of continuous listening, a shorter clip is valid. Show the actual duration. Do not fill the range with unheard audio merely to reach the minimum.

**Playback speed:** ranges refer to original episode time. Listening at 2× does not turn a 60-second segment into a 30-second recording.

**Failure handling:** save the anchor before any AI work. If semantic selection fails, use a deterministic recent range, target 60 seconds, and show that it is a fallback. If transcription or rendering is still pending, retain the capture and retry; do not lose it or present an empty result as complete.

**Offline:** store taps locally with episode, exact audio version, playback position, and a client request ID. Sync and automatically publish when the connection returns. Show **Waiting for connection**, then processing/publication state. Immediate public availability requires connectivity.

**Editing:** dragging a transcript boundary updates the selected words and audio preview. Numeric editing permits exact corrections; 30–180 seconds is the automatic-selection rule, not an arbitrary prohibition on deliberate manual edits. A boundary edit regenerates the segment transcript, AI summary, and clip file. Preserve user-written notes separately from generated summaries.

**Public edits:** keep the same share URL while publishing the latest saved revision. Temporarily withdraw the previous public content when a boundary edit is saved, then publish the new matching audio/text together. Saving an edit updates publication automatically. Revoking a link is sticky: subsequent edits or retries must not republish it without a deliberate restore action.

## Automatic public sharing, including private feeds

Every newly created snip automatically receives a public, unlisted link. Anyone with the link can open it, play the standalone recording, and read that section's transcript and summary. Do not add a publication confirmation on private-feed snips.

| Resource | Owner | Recipient with snip link |
| --- | --- | --- |
| Full private recording | Play and seek | No access |
| Private feed URL or credential | Manage in settings | Never exposed |
| Full private transcript and chapter list | Read and navigate | No access |
| Selected snip recording | Play and edit | Play only the published recording |
| Selected transcript and segment summary | Read and edit | Read the published revision |
| Other snips from the episode | Browse | Only those separately included in an episode share page |
| Listening history and private notes | Read and edit | No access unless a note is deliberately included |

This requires real clip files on the server. A player that merely starts and stops the full private recording at particular timestamps would still expose the rest of the file to recipients.

Make **Copy link**, **Unpublish**, and **Delete** easy to find. Public pages should be excluded from search indexing and should not advertise a browsable directory of all snips. Unlisted links are still public; revocation stops future access through the service but cannot recall recordings or text someone already saved.

Private-source attribution can include show and episode titles. Do not copy raw private show notes, access links, or embedded tracking URLs into the public page. An episode-level share of a private episode is a collection of selected public excerpts, not access to the full episode or its complete summary/transcript.

## Interaction and visual direction

Use Snipd's short path from capture to useful insight, cards combining audio and text, chapter navigation, and easy movement back to the episode as the main inspiration. Use original visual assets and identity. A quiet dark theme, artwork, strong typography, and one accent color can keep long listening sessions comfortable; also support light mode and system preference.

Target 44px minimum touch controls, readable transcript text, screen-reader labels, visible focus, sufficient contrast, and reduced-motion support. Auto-following the transcript stops when the reader scrolls away, with a clear **Follow audio** control to return. Never use color alone for pending, failed, or public states.

**Text size.** The larger type scale chosen in the mockups (the "A+" Night Shift screens, October 21, 2026) is the default for everyone, not an accessibility option: 18 for body text and list titles, 20 for the transcript, 24 for the player title, and nothing below 14 (CSS pixels on the web, points on iOS), with sentence-case labels instead of small capitals. From that default the app follows the system text-size setting in both directions. Layouts reflow instead of clipping: rows of controls wrap or stack, no container around text has a fixed height, touch targets grow with the text, and only list titles truncate (after two lines, with the full title on the detail screen). Play and Snip stay visible on the player without scrolling at every size; artwork shrinks or hides first. Every screen is checked at larger sizes before release (see [acceptance targets](delivery.md#acceptance-targets)).

Core listening features belong in the MVP: queue, resume, speed, skip, seek, sleep timer, chapters, transcript search, snips, and sharing. Broader discovery, podcast chat, automatic insight suggestions, knowledge-app sync, quote images, video exports, Apple Watch, and CarPlay can follow after the core loop works reliably.
