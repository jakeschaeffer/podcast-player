# 4. Episode transcription

**Contract:** given a stored audio asset, produce an immutable transcript of word-timed, speaker-labelled text in the normalized shape every other function reads. Provider choice must be invisible above the adapter boundary.

## Decision: ElevenLabs Scribe v2 first, local Whisper as a fallback adapter

The planning draft preferred local faster-whisper to avoid a per-hour bill. Having checked the current numbers (October 21, 2026), the better engineering choice for this host is ElevenLabs Scribe v2 as the primary transcriber:

| Consideration | Scribe v2 (hosted) | faster-whisper (local, CPU INT8) |
| --- | --- | --- |
| Accuracy | 5.83% average WER on the Open ASR Leaderboard | 7.44% (Whisper large-v3 class); the small/medium models that fit a 4-thread CPU at useful speed do worse |
| Word timestamps | Built in | Built in, but less reliable across pauses and music |
| Speaker labels | Built in, up to 32 speakers | Requires a separate pyannote pipeline, heavy on CPU and RAM |
| Audio events (music, applause) | Tagged in the response; useful for detecting intros and ad breaks | Not available |
| Vocabulary | Keyterm prompting, up to 1000 terms, at +20% cost | Prompt text only |
| File limits | 3 GB and 10 hours in one request; no chunking or offset merging | Chunking and VAD code to write and maintain |
| Host impact | None; the worker uploads bytes and waits | Hours of CPU per day on the same 4 threads that serve playback, no GPU |
| Operational surface | One HTTPS call, TypeScript SDK | Python, CTranslate2, model downloads, memory tuning |
| Cost | $0.22 per audio hour at the listed API rate on paid plans (one third-party tracker lists $0.40 per hour; confirm on the plan actually chosen); free tier covers about 12 minutes a month | Zero marginal, but the host cannot also do everything else |
| Privacy | Private-feed audio leaves the server to a SOC 2 and ISO 27001 vendor | Stays on the host |

At 100 hours of new audio a month the bill is roughly $22 to $40. The one real cost is privacy: private-feed audio is uploaded to a third party. That is acceptable for a personal deployment and is the reason the local adapter stays in the design, behind an explicit per-feed switch, for any feed the owner would rather keep on the box. Sources: [ElevenLabs speech-to-text docs](https://elevenlabs.io/docs/capabilities/speech-to-text), [API reference](https://elevenlabs.io/docs/api-reference/speech-to-text/convert), [Open ASR Leaderboard summary](https://speechtotext.dev/model/elevenlabs-scribe-v2).

The ElevenLabs CLI onboarding (`npx @elevenlabs/cli onboard init`) has been run in the repository. It created `.env.local` for `ELEVENLABS_API_KEY` and a `.gitignore` entry for it. The key is added by hand and verified with `npx @elevenlabs/cli onboard check --env-path .env.local`; the SDK reads it from the environment and it is never written into code or docs.

## Adapter boundary

```ts
interface Transcriber {
  readonly name: string;                     // 'elevenlabs' | 'whisper-local'
  transcribe(input: {
    path: string; mime: string; duration_ms: number;
    language?: string;                       // feed language if known; otherwise auto-detect
    keyterms?: string[];                     // show-specific names; optional, costs extra on ElevenLabs
  }): Promise<RawTranscript>;
}

type RawWord = { text: string; start_ms: number; end_ms: number; speaker?: string; confidence?: number };
type RawEvent = { label: string; start_ms: number; end_ms: number };
type RawTranscript = {
  provider: string; model: string; language: string;
  words: RawWord[]; events: RawEvent[]; cost_cents?: number;
};
```

`normalize(raw) → { segments, word_count, events }` is pure and shared by every adapter. It drops spacing tokens, rounds seconds to integer milliseconds, enforces monotonic non-overlapping words (a word that starts before the previous one ends is clamped), groups words into segments at speaker changes and at pauses of 700 ms or more, closes a segment at the first sentence end once it holds 40 words, and never lets one exceed 60 words. Segments are therefore speaker-turn paragraphs for display and search; sentences are derived from words by the sentencizer when a function needs them. Global word indices are assigned here, once, and never change.

ElevenLabs call: `POST /v1/speech-to-text` with `model_id=scribe_v2`, `timestamps_granularity=word`, `diarize=true`, `tag_audio_events=true`, the file as multipart bytes, `language_code` when the feed declares one, and `keyterms` when the feed has a configured list. The response's `words[]` carries `type` (`word`, `spacing`, `audio_event`), `start`, `end`, and `speaker_id`; audio events become `events`, spacing is dropped. Use a synchronous request with a 15-minute timeout for anything up to three hours, and the `webhook` option for longer files once the public hostname exists. Retry on 429 and 5xx with backoff up to three attempts; a 4xx other than 429 fails the job with the provider message.

The feed URL is never sent to the provider, only the bytes already on disk.

The local adapter wraps faster-whisper in a subprocess with the same output shape, without diarization (speaker is null). It is selected per feed with `feed.transcriber = 'whisper-local'` and is not installed until a feed needs it.

**Publisher text as a second source (built October 21, 2026).** When a publisher publishes the episode text, as Stratechery does in a second RSS feed, that feed is attached as a text feed to the podcast feed and refreshed on the same schedule (an email mailbox can serve as the source instead, through the optional `sync_email` job). Each item is matched to an episode by title and date, its article body extracted (the preamble the podcast reads, section headings, paragraphs, quoted blocks, speaker prefixes in interviews; mail chrome and footer dropped), and the `align_text` job sends that text with the stored audio to ElevenLabs forced alignment. The result is stored as a second transcript (`source = 'rss'` or `'email'`) with the publisher's speaker names kept and section start times recorded on `episode_text`. Measured against Scribe on 58 episodes, the two agree on word starts within 20 ms at p90; the publisher text is cleaner for monologue episodes and incomplete for edited interview transcripts. Policy (`TEXT_PREFERRED_KINDS`, default Updates and Articles): the text-aligned transcript is the current one for those kinds and ASR for the rest; the publisher's section headings become the episode's chapters. On the owner's Readwise cases the cleaner punctuation also lifted the deterministic snip selector from 35% to 39% no-edit. Details and the policy recommendation are in [evals/transcription/README.md](../../evals/transcription/README.md). The same path fits `podcast:transcript` feeds: align the publisher's text to our asset instead of trusting its timings.

An article aligned first does not stand in for speech: the `transcribe` job still runs unless the recording has an ASR transcript or a video's captions, so interviews end on ASR and ad detection has the speech whichever job finishes first. It skips a recording the episode has moved on from unless a snip waits on it. A video that replaces the recording gets the article aligned again, since it has its own timeline.

## When transcription runs

| Trigger | Priority | Why |
| --- | --- | --- |
| A snip is created on an asset with no transcript | 100 | The owner is waiting on a public link |
| The owner starts playing an asset with no transcript | 50 | Snips are likely within minutes; a one-hour episode transcribes in a few minutes |
| Daily refresh finds new episodes on `auto_process` feeds | 0 | Catalog work, newest first |

Job key `transcribe:<asset_id>` deduplicates across triggers; a later higher-priority trigger raises the existing job's priority. A monthly budget in `setting` (`transcription_budget_minutes`) defers priority-0 work visibly when exceeded; priority-50 and 100 work runs regardless, because those are explicit owner actions. `transcript.cost_cents` is computed from measured duration and the configured rate so the settings screen can show spend to date.

## Evals

Reference set (`evals/transcription/fixtures/`, kept out of version control): six to ten clips of three to five minutes from the owner's actual shows, chosen to cover a clean interview, cross-talk, names and technical vocabulary, a music-to-speech transition, non-native accents, and any non-English speech the library contains. Each gets a hand-corrected transcript once (start from the best model output, correct it, freeze it) plus, for about 50 words per clip, a hand-marked onset time from a waveform editor.

Metrics, computed by one runner over any adapter (`pnpm eval transcription --provider elevenlabs|whisper-local`):

| Metric | Definition | Target |
| --- | --- | --- |
| WER | Word error rate after normalization (case, punctuation, numerals) | ≤ 8% on the owner's shows |
| Name recall | Share of the per-show name list transcribed correctly | ≥ 90% with keyterms |
| Onset error | Median and p95 of the absolute difference between predicted and hand-marked word start | median ≤ 100 ms, p95 ≤ 300 ms |
| Speaker turn accuracy | Share of hand-marked turn changes that produce a label change within 1 s | ≥ 90% |
| Turnaround | Seconds of wall time per hour of audio | report |
| Cost | Cents per hour, from the ledger | report |

Invariants (unit tests over `normalize` with fixture inputs): words strictly ordered and non-overlapping, every `end_ms ≤ duration_ms`, segment `first_word` values contiguous and summing to `word_count`, no empty segments, deterministic output for the same input.

The first recorded baseline compares Scribe v2 against faster-whisper `small` and `medium` on the same clips, so the privacy fallback has a known quality cost.
