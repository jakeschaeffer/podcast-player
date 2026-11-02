# Core specification

Written October 21, 2026. This folder narrows the planning draft in the parent `docs/` folder to the parts that have to be right: a minimal data model and six core functions, each with a contract, an algorithm, and an eval plan. Everything else in the app (library screens, settings, OPML import, episode share pages) is a thin layer over these six and is deliberately not specified here yet.

| # | Function | One-line contract | Spec |
| --- | --- | --- | --- |
| 1 | Episode playback | Turn an RSS item, public or private, into an immutable stored recording the owner can stream, seek, and resume on any device | [01-playback.md](01-playback.md) |
| 2 | Snip selection | Turn a tap at anchor `T` into one contiguous span of already-heard audio that holds one idea | [02-snip-selection.md](02-snip-selection.md) |
| 3 | Snip storage and sharing | Turn a span into an immutable revision with a rendered clip, an exact excerpt, and a stable public link | [03-snip-storage-sharing.md](03-snip-storage-sharing.md) |
| 4 | Episode transcription | Turn a stored recording into word-timed, speaker-labelled text | [04-transcription.md](04-transcription.md) |
| 5 | Snip summarization | Turn an excerpt into a title and a summary grounded only in that excerpt | [05-snip-summary.md](05-snip-summary.md) |
| 6 | Episode summarization | Turn a transcript into a preview, chapters that seek the player, and takeaways | [06-episode-summary.md](06-episode-summary.md) |

The [data model](data-model.md) is shared by all six. [architecture.md](architecture.md) records the stack and the decisions that matter for a later iOS app.

## Build order versus dependency order

The numbering is the order of user-visible value: a player that plays, a button that snips, a link that works, then the AI that makes the snips good. The dependency order is different:

```text
1 playback ──► 4 transcription ──► 2 selection ──► 3 storage/sharing
                      │                                    ▲
                      ├──► 5 snip summary ─────────────────┘
                      └──► 6 episode summary
```

To build in the numbered order, function 2 ships first with its deterministic fallback (a fixed 60-second span ending at the tap) and function 3 publishes audio-only pages. Transcription then upgrades selection to sentence boundaries and unlocks excerpts and summaries without changing any data shapes. Each function is a module with a pure core (`input -> output`, no I/O) and a thin job wrapper, so the evals call the pure function directly.

## Conventions every function shares

- **Time is integer milliseconds relative to one `audio_asset`.** Nothing stores a timestamp without being reachable from the asset it belongs to. Feed durations and wall-clock time never enter a calculation about audio.
- **Words are the coordinate system.** A transcript is a numbered list of words (`0..N-1`). Snips store word ranges `[start_word, end_word)` plus derived milliseconds. Language models never emit timestamps; they emit sentence or word ids, and the server computes times from the transcript.
- **Immutable artifacts, mutable pointers.** `audio_asset`, `transcript`, `episode_summary`, and `snip_revision` never change once ready. "Current" is a pointer on the parent (`episode.current_asset_id`, `snip.current_revision_id`). Every cache, race, and eval becomes simple because an id always means the same bytes.
- **Two provider interfaces, nothing else.** `Transcriber` (audio in, timed words out) and `TextModel` (prompt and JSON schema in, validated JSON out). Everything else is deterministic code that can run in a test without network access.
- **Nothing publishes except the publication step.** Models propose; the server validates and writes. A model output that fails validation falls back to a deterministic result or leaves the artifact pending. It never reaches a public page.

## Evals

Each function has an `evals/<function>/` directory with `cases/` (JSON fixtures), a runner, and a `results/` folder of dated scorecards. Three levels, from cheapest to most expensive:

| Level | What it checks | Pass rule |
| --- | --- | --- |
| Invariants | Properties that must always hold, as unit tests over the pure function (spans inside the window, chapters cover the episode, cited ids exist) | 100%, in CI |
| Fixtures | Deterministic cases with expected output or acceptable ranges, derived from the owner's real episodes | Tracked metric per spec; regressions block |
| Judged | Quality that needs a reader: boundary usefulness, summary faithfulness, chapter titles. A different model than the generator as judge, plus the owner's in-app thumbs up/down | Tracked over time; compared across prompt and provider versions |

Fixtures come from real listening, not synthetic text: every manual boundary edit and every thumbs-down in the app is logged as a candidate eval case. Private-feed fixtures stay out of version control; the eval runner reads them from a local fixtures directory.

## Status

| Function | Spec | Pure core | Job wiring | Eval cases | Baseline recorded |
| --- | --- | --- | --- | --- | --- |
| 1 Playback | Draft | feed parser, download validation, range serving, resume merge | refresh, fetch, media, playback routes; scheduled refresh in the worker | parser and queue unit tests; end-to-end integration test | – (device checklist pending) |
| 2 Snip selection | Draft | sentencizer, heuristic scorer, model-pick validation, padding, fixed fallback | `select_snip` job | 510 cases from 102 aligned Readwise snips (Stratechery), builder and runner in `server/src/evals/snip-selection/` | Yes, October 21, 2026: fixed-90 27% no-edit, scored v1 heuristic 17%, snap-90 (now the default, `select_v2`) 35% on ASR transcripts and 39% on publisher-text transcripts, snap-90 plus Codex start pick 27% (5 s per call); see `evals/snip-selection/README.md` |
| 3 Storage and sharing | Draft | clip args and verified render, public view whitelist | `render_clip` job, public routes, revisions, revocation | integration test covers idempotency, revision race, revocation, containment of private fields | – (synthetic-marker containment test pending) |
| 4 Transcription | Decided: Scribe v2, plus publisher text (text feed, or email) via forced alignment | normalizer, ElevenLabs mapping, newsletter extractor, forced-alignment mapping | `transcribe` and `align_text` jobs; text feeds refresh with podcast feeds; optional `sync_email` | unit tests; 62 Stratechery episodes transcribed; 58 also aligned from email text | Yes: email text and Scribe agree on word starts within 20 ms (p90); email is the better text for Updates and Articles, ASR for Interviews; see `evals/transcription/README.md` |
| 5 Snip summary | Draft | prompt v1, validation, name guard, one regeneration | `summarize_snip` job; owner titles kept and logged as ground truth | 228 owner-written titles from Readwise plus every title edited in the app; builder and runner in `server/src/evals/snip-titles/` | Yes, October 23, 2026: titles 3.61/5, 63% same point as the owner's; see `evals/snip-titles/README.md` |
| 6 Episode summary | Draft | prompt v1, single-pass and windowed modes, chapter repair and validation | `summarize_episode` job; publisher sections take precedence as chapters when available | repair and mode unit tests with a scripted model; first live run October 21, 2026 on a 44-minute Latent Space episode: preview, 7 takeaways, 10 chapters with kinds, no repairs, 26 s on Codex at low effort | – (boundary labels pending) |

Implementation lives in [`server/`](../../server/README.md). As of October 21, 2026 the whole pipeline runs end to end against the owner's feeds: Stratechery (automatic, with publisher text from its text feed) and Latent Space (manual mode, processed on request). Model-assisted snip selection is off by default on the strength of the evals; summaries run on the Codex subscription.

Update this table as each column lands; it is the progress view for the project.

Since the table above was written (October 21, 2026), the player has grown beyond the six functions without changing
them: a play queue with auto-advance, video as a recording with a picture (YouTube channels, a home fetcher, captions
as transcripts; [../video-plan.md](../video-plan.md)), and a native iOS app with offline downloads
([../../ios/README.md](../../ios/README.md)). The native app ports the pure cores against `contracts/golden/`.
