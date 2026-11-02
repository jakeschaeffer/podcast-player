# Delivery plan and costs

The first release should demonstrate a reliable daily listening loop and automatically published snips. The milestones below are ordered by dependency; they are not calendar commitments. Estimate implementation effort after the initial audio, migration, and iPhone experiments resolve their uncertainties.

## Milestones

| Milestone | Deliverable | Exit evidence |
| --- | --- | --- |
| 0. Resolve the main unknowns | Inspect a Snipd export, inventory feeds, benchmark local transcription and unattended Codex analysis, and test web playback on an iPhone | Usable import path; timestamp quality and daily throughput; Codex usage and clip latency; browser/native decision |
| 1. Complete one flow from listening to sharing | One public and one private RSS episode, saved audio, transcript, AI chapters, mobile player, one-tap snip, automatic public recording/text, timestamp edit, and revoke | A signed-out recipient can play both types of snip without reaching the full source episode; edits update the same URL |
| 2. Make it a daily player | OPML/RSS import, subscriptions, queue/resume, transcript search, speed/skip/sleep timer, daily cron and Codex analysis jobs, snip library, finished-episode share pages | Repeated calls deduplicate; quota/authentication failures defer visibly; multiple devices preserve progress; a finished episode produces a selected-snips page |
| 3. Deploy and use it | Production assets/API/worker under nginx/systemd; HTTPS, authentication, backups, resource limits, monitoring, retention, and exports | Real-device listening checks; a successful restore; restart/retry tests; one week of observable daily runs |
| 4. Native iOS companion | SwiftUI player, background audio, remote snipping controls, downloads, offline capture/sync, universal links | Device-tested offline and headset behavior; same accounts, audio IDs, snips, and share URLs as the web app |
| Later enhancements | Readwise/Markdown sync, saved tags, episode chat, daily highlight review, custom prompts, quote/video export, CarPlay/Watch | Prioritized from actual use rather than delaying the core player |

If iPhone web playback does not meet the everyday-use bar during milestone 0, retain the web library/editor/public pages and advance the native playback work. The server API remains useful in either order.

## First experiments

**Migration:** use a small real Snipd Markdown export to learn its schema, and verify whether the installed version offers a subscription export. Test 3 public feeds and 2 private feeds with different authentication patterns. Record private feed identifiers securely; do not put credential-bearing URLs in source control or planning documents. Validate public/private editions separately, even when episode titles match.

**Transcription:** benchmark local faster-whisper CPU INT8 on 6–10 representative episodes or selected test windows: clean interview, overlapping speakers, proper names/technical vocabulary, music/ad transitions, a long episode, and any relevant non-English speech. Assess accuracy, word timing, real-time factor, peak RAM, and impact on playback. Speaker labeling is a separate optional local step. If the result misses the quality or daily-capacity target, compare a smaller local model, additional compute, and hosted providers before choosing a fallback.

**Codex automation:** run bounded, schema-constrained chapter/preview analysis using ChatGPT sign-in in an unattended service environment. Measure observed allowance consumption, completion time, long-episode chunk merging, and quota/authentication recovery. Compare runtime boundary-plus-summary requests against exact precomputed candidates; test candidate coverage, edited ranges, and pending transcripts. See the [Codex routine plan](codex-routines.md).

**Snip quality:** label roughly 30 taps from the test audio with the intended idea and acceptable start/end range. Compare semantic selection against fixed 30-, 60-, 90-, and 180-second baselines. Include mid-sentence taps, reaction delays, episode starts, silence, pauses, 2× playback, and recent seeks.

**Public clip containment:** use a synthetic recording with distinct spoken markers before, inside, and after the chosen range. Confirm that neither the public media endpoint nor transcript/HTML/link-preview endpoints disclose the outside markers, even with crafted range requests or guessed parent asset IDs. Then verify with a real private-source snip.

**Device behavior:** test Safari and a Home Screen installation on the intended iPhone, then a native spike if needed. Browser emulation alone does not establish background audio, AirPods behavior, interruptions, or offline reliability.

## Acceptance targets

These are proposed test targets, not measured performance claims.

| Area | Target |
| --- | --- |
| Capture feedback | Local acknowledgement within 150 ms at p95; offline captures persist across reload/restart |
| Snip quality | At least 80% of the labeled tap examples are useful without boundary edits; all spans obey the automatic window or documented short exception |
| Word/chapter alignment | Seek within 1 second of the intended word/section at 95% of sampled anchors on the stored asset |
| Clip rendering | Rendered boundaries match requested source boundaries within 250 ms; playback ends at the clip end, including when the browser is backgrounded |
| Ready-episode latency | Public audio, transcript, and summary available within 15 seconds at p95 for already transcribed episodes under the tested load |
| Summary grounding | Every statement in the evaluation sample is supported by the selected segment; zero observed facts borrowed only from outside it |
| Automatic publication | A new snip receives a stable public link without another user action, including private-feed and later-synced offline captures |
| Edit consistency | A saved boundary change updates audio, transcript, and summary together; stale worker results cannot publish |
| Revocation | Revoked/deleted shares stop serving through every app endpoint, including episode collections; retries cannot restore them |
| Daily refresh | Repeated triggers and restarts produce no duplicate episodes or processing jobs; failed/deferred episodes are explicitly reported |
| Batch capacity | Representative daily audio volume completes within the selected processing window without degrading playback; measured before promising capacity |
| Subscription limits | Quota/authentication failure preserves queued work and playback; no automatic paid-provider switch |
| Cost limits | In-flight reservations count against caps; reaching the cap creates visible deferred work |
| Playback | Queue/resume, chapter seek, 2× playback, full-episode progress isolation from clip previews, and a 30-minute locked-screen session pass on the target device |
| Text size | Every screen works at the default scale (18 body) and at 130%, 160%, and 200% of it in the browser, and at every iOS Dynamic Type size through AX3 on the target iPhone: no clipped, overlapping, or cut-off text, no horizontal scrolling, every control reachable, and Play and Snip visible on the player without scrolling. Checked on each release |
| Asset durability | Removing unpinned cache does not break saved snips; an off-host backup restores a working snip and its source for editing |

Prioritize integration tests around asset identity, import deduplication, job recovery, public excerpt containment, and publication revisions. These are the costly failures. Use hands-on listening review for semantic boundaries and native behavior.

## Cost model

Resource use follows **new audio processed**, which may be much larger than audio actually listened to. Refreshing RSS feeds and reading an already stored transcript do not require another transcription request. A snip from a prepared episode reuses its transcript; it needs only boundary selection, a short summary, and audio rendering, with exact cached candidates potentially avoiding live inference.

The preferred scenario is **local transcription plus Codex subscription analysis**. It targets no additional per-minute transcription or per-token analysis bill while local compute and included allowance suffice. Count existing server/subscription costs and measure contention with the owner's other Codex work. More compute, extra credits, backup storage, or an optional runtime clip API would add costs. See [Codex routines](codex-routines.md) for limits and the benchmark. Hosted transcription is an explicitly chosen alternative, not the baseline.

For comparison, listed hosted prerecorded transcription prices checked September 14, 2026:

| New audio / month | AssemblyAI at $0.23/hour, with diarization | Deepgram Nova-3 monolingual at $0.258/hour, with diarization | Whisper API at $0.36/hour |
| --- | ---: | ---: | ---: |
| 30 hours | $6.90 | $7.74 | $10.80 |
| 100 hours | $23.00 | $25.80 | $36.00 |
| 300 hours | $69.00 | $77.40 | $108.00 |

The AssemblyAI figure includes its listed $0.02/hour diarization add-on; Deepgram lists diarization as included for prerecorded audio. Whisper's column is transcription only and does not include a separate speaker-labeling step. [AssemblyAI pricing](https://www.assemblyai.com/pricing/), [Deepgram pricing](https://deepgram.com/pricing), [Whisper pricing](https://developers.openai.com/api/docs/models/whisper-1).

If choosing paid text APIs, add text generation using the provider's actual rates:

```text
text cost = input_tokens / 1,000,000 × input_price_per_million
          + output_tokens / 1,000,000 × output_price_per_million
```

For a transparent illustration, assume 100 audio hours, 20,000 input tokens and 1,500 output tokens per hour across chapter/preview passes, and 200 snips using 1,000 input and 200 output tokens each. This totals **2.2 million input tokens and 190,000 output tokens**. At hypothetical rates of $1/million input and $5/million output, the text cost is **$3.15**. Those token volumes and rates are planning assumptions, not a measured workload or a vendor quote. A more expensive model, repeated whole-episode prompts, long context, or heavy retries can change the total substantially.

For the **hosted alternative** at **100 hours/month**, the earlier **$35–50/month in incremental AI spend** envelope covers a timestamp-and-speaker transcription provider, economical text processing, and modest retries. It does not apply to the preferred local/Codex-subscription path. This alternative excludes the existing server bill, storage backups, bandwidth, taxes, and app-store costs, and must be revised after a benchmark. No paid services were invoked in this research.

Storage arithmetic, using decimal units:

```text
audio_GB = hours × bitrate_kbps × 3600 / 8 / 1,000,000
```

At 128 kbps, 100 hours of source audio occupy about **5.76 GB**; 300 hours occupy **17.28 GB**. At 96 kbps, 200 snips averaging 90 seconds occupy approximately **0.216 GB**. Actual feed bitrates vary; temporary conversions, metadata, and backups add to these figures. A second copy approximately doubles the relevant storage. Saved-snip source assets accumulate over time because retaining them enables timestamp expansion and re-editing; they are not part of an automatically disposable cache.

The inspected host's 108 GiB of available space is sufficient to justify a pilot, not an indefinite retention promise. Set a storage budget and show projected retention before admitting a large backfill. Clip-sharing bandwidth depends on recipient plays and must be measured separately from transcription.

## Decisions recorded and still open

| Decision | Status |
| --- | --- |
| Current app | Confirmed: Snipd |
| Private subscriptions | Confirmed: included |
| Routine provider | Updated: server cron with the owner's Codex subscription for analysis; retain portable backend interfaces |
| Snip publication | Confirmed: automatic on every new snip, including private-source audio/transcripts |
| Deployment | Confirmed: this server; proposed nginx/systemd application services |
| Native direction | Confirmed: eventual iOS companion; proposed shared API with SwiftUI/native playback |
| Initial account scope | Assumed: one owner; keep owner IDs in records for future expansion |
| AI provider and actual budget | Updated October 21, 2026: ElevenLabs Scribe v2 for transcription (about $22–40 per 100 audio hours), Codex subscription for analysis; local Whisper kept as a per-feed fallback. Measure quota consumption and runtime clip latency |
| Feed migration | Verify actual Snipd export capabilities; RSS/OPML ingestion is the fallback foundation |
| Historical snips | Optional legacy import; playable re-publication depends on recoverable source audio and verified timing |
| Backfill / retention | Proposed new-episodes-first, selectable older processing, saved-snip source retention |
| Languages and monthly volume | Not yet known; affect transcription mode and operating cost |
| Public hostname / native signing setup | Not selected; needed before deployment/native distribution |

The research/planning deliverable is complete enough to begin milestone 0. The next concrete work is a small migration and audio-quality evaluation followed by the two-episode vertical slice, with automatic publication of snips from private feeds already fixed in the specification.
