# Codex routines and inference split

Decision updated September 14, 2026: prefer daily processing through the owner's Codex subscription, with only small, clip-specific inference during listening. This is viable for a personal deployment, subject to a local transcription benchmark and available subscription allowance. The backend and processing formats remain independent of the routine provider.

## Verified capabilities

Codex supports non-interactive `codex exec` runs, saved CLI authentication, and schema-constrained output. Its automation documentation explicitly describes running with a Codex user account when ChatGPT/Codex limits are desired. Linux cron can launch that command on this server. [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode).

The server has Codex CLI **0.154.0**, and `codex login status` reported ChatGPT sign-in. An unattended inference run, available allowance, and long-term credential operation have not been tested. No schedule was installed during planning.

Subscription authentication and Platform API billing are separate. Invoking a paid speech-to-text API from Codex still incurs the provider's charges. [Authentication and billing](https://learn.chatgpt.com/docs/auth). Codex analysis shares the account's allowance with other Codex work; workload and model choice affect consumption, and weekly limits can apply. [Usage limits](https://learn.chatgpt.com/docs/pricing).

## Proposed daily pipeline

| Stage | Executor | Resource used |
| --- | --- | --- |
| Refresh RSS, discover episodes, download stable audio | Ordinary server worker, triggered by cron | Server CPU, disk, network |
| Obtain word-aligned transcript | ElevenLabs Scribe v2 (decided October 21, 2026); local faster-whisper as a per-feed fallback | Per-hour API charge, about $0.22–0.40; no host CPU |
| Create chapters and episode preview | Bounded Codex CLI jobs with ChatGPT sign-in | Codex subscription allowance |
| Prepare thought boundaries and optional candidate summaries | Scheduled analysis pipeline | Codex subscription allowance |
| Validate and save results | Ordinary worker and database | Server resources |

Local faster-whisper supports CPU INT8 execution and word timestamps. Benchmark this path; do not assume the subscription includes a long-form audio transcription service with the required alignment. Speaker labeling requires a separate workflow, so initially omit speaker names if necessary. [Project documentation](https://github.com/SYSTRAN/faster-whisper).

The host has four available CPU threads and 7.6 GiB RAM, with other services running. Start with one constrained transcription worker and measure real-time factor, peak RAM, word alignment, and impact on playback. If daily volume does not fit, compare a smaller local model, more compute, and an explicitly enabled hosted adapter.

Cron enqueues a durable daily refresh; workers advance individual episodes. The worker launches Codex when transcript analysis is ready, using fresh bounded input and a JSON output schema. Chunk long transcripts and merge chapter proposals. A deterministic worker validates and commits results; the model does not write production database rows directly.

Deduplicate by audio checksum, transcript version, analysis/prompt version, and operation. Use checkpoints, deadlines, bounded concurrency, and per-job retries. Quota or authentication failure leaves analysis pending and visible without blocking downloads, playback, or prepared content. Do not silently switch to paid APIs. Show the last successful refresh and use the same operation for manual catch-up after downtime.

Use Linux cron on the always-on host. Built-in scheduled tasks have different environments: desktop tasks needing local files require the computer and app to remain running, while web tasks cannot directly use a local project directory. [Scheduled-task environments](https://learn.chatgpt.com/docs/automations).

## When Snip is tapped

Persist the playback anchor immediately. A prepared episode needs no audio transcription or whole-episode analysis. A small text request can select boundary word IDs within the eligible last 30–180 seconds and generate the chosen segment's title and summary. FFmpeg cutting, transcript extraction, and link serving are ordinary application work.

Two modes are possible:

1. **Flexible boundaries, recommended initially:** one clip-specific request proposes the span and summary together, with supporting word IDs for each claim. Validate bounds and evidence containment. If grounding is questionable, regenerate the summary using only the accepted excerpt, or leave preparation pending. One request is the normal case, not a guarantee against retries.
2. **Only boundary selection during listening:** precompute a finite collection of spans and summaries in the daily run. Select a candidate wholly inside the eligible, already-heard window. Reuse its summary only when the asset, transcript version, and exact span match. A chapter summary cannot stand in for a smaller excerpt. Uncovered taps and arbitrary timestamp edits still need a new summary, or must wait for scheduled processing.

The second mode may let many taps use deterministic ranking without a live model call. It cannot guarantee a suitable cached result for every tap and edit. Measure coverage before making it the default.

Runtime clip requests may use the same Codex subscription adapter, but startup latency and shared limits need measurement. A small paid text API is an optional alternative if measured latency is unacceptable. Public visitors only read prepared artifacts and never trigger inference. Captures from episodes awaiting transcripts remain queued by default; urgent local-window transcription is an optional exception to batch-only transcription.

Every new snip still receives an automatic public link, including private-source snips. It shows a generic preparing state until the matching recording, excerpt, and summary are ready. Existing editing and revocation rules remain in the [product specification](product.md).

## Access, capacity, and cost

The analysis runner receives relevant transcripts, including private-feed text, for processing through Codex. Supply them through a restricted job directory or scoped internal interface. Exclude feed credentials, unrelated owner data, and publication tools. Keep runtime data and Codex credentials out of source control and public routes; configure a dedicated service identity before deployment. Episode speech is source material, not instructions for the worker.

The first experiment should transcribe representative audio locally, run chapter analysis unattended, and exercise clip selection and timestamp edits. Measure completion within the chosen daily window, analysis quality, observed subscription usage, clip latency, and quota/authentication recovery. Installation alone does not establish production capacity.

Incremental AI charges can be zero while local compute and included allowance suffice. Existing subscription/server costs remain; extra credits, more compute, backups, or an optional clip API add spend. The earlier hosted-provider estimate remains an alternative in the [cost model](delivery.md), not this design's baseline.
