# Video: plan (2026-10-31)

**Status (2026-11-01):** done and deployed: server foundation, YouTube channels as shows, the home fetcher on TrueNAS
(480p), captions as transcripts, web and iOS playback, full-screen landscape video on iOS, one snip thread per
episode with an audio/video mark, pruning (a day after finishing, 4 GB cap), iOS offline downloads, and pasting a
channel or video link. Still open: SponsorBlock, hybrid caption timing.

Goal: watch videos as well as listen to podcasts, with everything the app already does for audio (transcripts,
ad skipping, snips, Up next), plus downloads for offline. Built on master in ordinary PRs, each tried against the
local server first (as with everything else), then deployed.

## Decisions (2026-10-31)

- **YouTube files are downloaded at home**: a small fetcher on the TrueNAS box runs yt-dlp over the home connection
  and uploads the video and audio to the server. The server never talks to YouTube except for the public channel feeds.
- **Transcripts from YouTube first**: the video's own captions (the creator's, else YouTube's automatic ones, which
  have word timings) become the transcript when there are any; ElevenLabs is the fallback, and can be asked for when
  speaker names matter (YouTube captions don't say who is speaking). No cap on ElevenLabs.
- **No separate test server or test app**: the work lands on master step by step (a test server on a copy of live
  data was set up and taken down again the same day).

## What the sources actually look like

- **Podcast feeds rarely carry video.** Dwarkesh's feed (both `api.substack.com/feed/podcast/69345.rss` and the
  Apple one) has 145 enclosures, all `audio/mpeg`. But 129 of the 145 episodes link their YouTube video in the show
  notes ("Watch on YouTube" → `youtu.be/<id>`). So for Dwarkesh, and most interview shows, "the video" is a
  YouTube video that the show notes point to.
- **Some feeds do ship video** as a `video/mp4` enclosure, or as a `<podcast:alternateEnclosure>` beside the audio.
  These are easy: same download path as audio.
- **YouTube channels have a public feed**: `https://www.youtube.com/feeds/videos.xml?channel_id=UC…` (Atom, the
  latest 15 videos with title, date, description and thumbnail). Following a channel is a feed refresh like any
  other. Shorts appear in it and should be dropped.
- **Getting a YouTube video's file** needs a downloader (yt-dlp). See "Risks" below: YouTube's terms forbid it,
  and YouTube often blocks downloads from data-centre addresses like Hetzner's.

## How it fits the current design

The core rule stays: time is milliseconds on one recording (an `audio_asset`), words are the coordinate system,
and every feature (heard tracking, snips, transcripts, ad breaks, chapters) hangs off that recording.

**A video is a recording with a picture.** When an episode's media is a video, the server keeps two files with the
same timeline: the video (`mp4`, H.264/AAC, 480p by default) and the audio track pulled out of it (`mp3`, as today).
Everything audio-based runs on the audio file unchanged: transcription, snips, ad detection, the karaoke view.
The video file is just another way to play the same timeline. Nothing in the snip, transcript or heard-tracking code
has to change.

- `audio_asset` gains `video_path`, `video_sha256`, `video_bytes`, `video_width`, `video_height`
  (one additive migration; the table keeps its name).
- `feed` gains `kind`: `podcast` (as now) or `youtube`.
- `episode` gains `media_kind` (`audio` | `video`) and `youtube_id` (from a YouTube feed, or from a podcast's show
  notes).
- The API's episode detail gains `asset.video_url` (signed, like `audio_url`), size and dimensions; list items gain
  `media_kind`, so the apps can filter.

**A podcast episode with a linked YouTube video** (Dwarkesh) gets a "Watch video" action. The video is its own
recording with its own timeline, because YouTube cuts often differ from the podcast cut (different intros, ad reads
in different places). That means its own transcript, which costs about 22¢ an hour again. Matching the video's
timeline to the podcast's, so one transcript and one resume point serve both, is possible (audio fingerprinting) but
is a later step, not the first.

Once the video arrives it is the episode's recording: "Audio only" plays the audio track pulled out of the video, and
stays on it after the video file is dropped, because the transcript, place and snips hang off that timeline. The feed's
recording is kept with its own transcript and snips, but the episode does not go back to it. Fetching a dropped video
again gives it back to its recording when the audio track is byte-identical; different audio is a new recording.

Your place comes along when the two recordings are within a second of each other in length, taken as the same cut. Each
device's place is copied, the newest observed place wins, and a device still playing the old recording keeps the current
one up to date. Equal length is strong evidence and not proof, so a place can land slightly off. Recordings of different
lengths keep their own places, because the same time in another cut is a different moment.

## Server work

1. **Fetching video**: a `fetch_video` job. For RSS video enclosures it is the existing download plus
   `ffmpeg -vn` to pull out the audio. For YouTube it runs `yt-dlp` for the best H.264 video up to the fetcher's
   `SNIP_MAX_HEIGHT` (480 by default) with AAC audio,
   merged without re-encoding, then pulls out the audio the same way. Both files go in the content-addressed store.
2. **YouTube channels**: "Add show" accepts a channel URL or `@handle`; the server finds the channel id and follows
   its Atom feed. Feed refresh learns the new format; Shorts (`/shorts/` links, or under 2 minutes) are dropped.
   A single video's link (`POST /v1/youtube/episodes`, since 2026-10-31) becomes an episode of its channel's show,
   created unfollowed when the library lacks it, read from the watch page (title, length, date, thumbnail), with its
   video asked for at once; a video an episode already names is that episode. The iOS show search offers both.
3. **Show notes → video**: during feed refresh, a podcast episode whose notes link one YouTube video gets
   `youtube_id`, which turns on "Watch video".
4. **Ad skipping**: the transcript-based ad detection works as it is. For YouTube there is also SponsorBlock, a
   free community list of sponsor segments per video; its segments join the ones detected from the transcript.
5. **Storage** (decided 2026-10-31): video is fetched only when it is wanted, never for the whole catalogue. A
   finished episode's video is dropped a day after the finished report, unless it is played again meanwhile; and
   the store is kept under `VIDEO_STORE_MAX_BYTES` (4 GB), the least recently played first, sparing anything fetched
   in the last day. The audio is always kept, so transcripts and snips never break when a video is dropped, and
   "Watch video" fetches it again. No transcoding: measured on the NAS, software HEVC was slow and hardly smaller
   than YouTube's own encode at a watchable quality (fetcher/README.md); the fetcher's `SNIP_MAX_HEIGHT` is the
   size lever (720p ≈ 350–450 MB an hour, 480p about half; 480 is the default since 2026-10-31, so the 4 GB cap
   holds about 20 hours).
6. **Snips from a video**: the clip stays an `mp3` as now, and an `mp4` with a poster is cut beside it so the public
   pages play the picture and link previews can (`og:video`). The cut needs the video on disk: a snip whose video has
   gone stays audio-only until the same recording is fetched again (an hourly sweep then cuts it).

## App work

- **iOS player**: `PlayerEngine` already uses `AVPlayer`, which plays video. Add a video surface where the artwork
  is; full-screen video when the phone turns sideways (a third choice beside "Read along" and "Turn the player");
  picture in picture; and keep playing as audio when the app goes to the background (detach the video layer, as
  Apple recommends). An "Audio only" switch plays the `mp3` instead, to save data.
- **Web player**: the engine's single `<audio>` element becomes a `<video>` element (same media API) shown where
  the artwork is; audio-only works the same way.
- **Filter**: Today and Library get **All · Podcasts · Videos**, from `feed.kind` and `media_kind`.
- **Snips, Up next, transcripts, chapters, karaoke**: unchanged, since they work on the shared timeline.

## Offline (iOS)

There are no downloads today: the app streams, and only snip taps and playback reports work offline. Offline means:

- A download manager on a background `URLSession`: download an episode as audio or as video into Application
  Support (excluded from iCloud backup), resumable, Wi-Fi only by default.
- The player plays the local file when there is one. Its transcript, chapters and ad breaks are saved with it, so
  the karaoke view, chapters and ad skipping work in airplane mode. Snip taps and progress already queue offline.
- Auto-download the first few Up next episodes (a setting: audio or video, how many), and a Downloads list with
  sizes, total storage, and swipe to delete.
- The web app stays online-only: Safari's storage for web apps is small and gets cleared, so it can't hold video.

## Risks

- **YouTube's terms** forbid downloading videos except through YouTube's own apps. This is personal use, so the
  practical risk is to the server's address and to any Google account used for cookies, not much else, but it is
  your call.
- **YouTube blocks data-centre downloads.** From Hetzner, yt-dlp often gets "Sign in to confirm you're not a bot".
  Ways around it, in order of preference: (a) try plain yt-dlp from Hetzner; (b) add a proof-of-origin token helper
  (`bgutil-ytdlp-pot-provider`); (c) download at home: a small fetcher on the TrueNAS box runs yt-dlp on a home
  connection and uploads the files to the server; (d) cookies from a spare Google account (risks that account).
  Decided: (c), the home fetcher.
- **If YouTube can't be downloaded at all**, video can still be watched through YouTube's own embedded player
  (allowed), but without offline, without its own transcript (the podcast's transcript can't be lined up with it
  reliably) and with YouTube's ads.
- **Storage**: about 150–250 MB per hour at 480p; the cap and the day-after-finishing rule keep it well inside the free disk.
- **Battery and data**: video streaming is heavier; "Audio only" and Wi-Fi-only downloads cover it.

## Order of work

1. Spike: yt-dlp on the TrueNAS box on one Dwarkesh video and its captions.
2. Data model, `fetch_video`, RSS video enclosures, and the iOS and web video players.
3. YouTube channels (follow, refresh, Shorts dropped) and "Watch video" for podcast episodes that link one.
4. Filter chips; SponsorBlock with the existing ad detection.
5. Offline downloads on iOS, then auto-download of Up next.
6. Video snip clips on the public page (done, 2026-11-01).
