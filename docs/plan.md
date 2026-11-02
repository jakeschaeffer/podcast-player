# Podcast player — research and plan

The project's original brief and plan index, kept as written. The repository README says what exists now.

Research date: September 14, 2026; core specification and first implementation October 21, 2026. Status: the server (API plus worker) runs the deterministic path end to end on the owner's private feed; summaries are wired behind a text-model adapter and not yet enabled; no web or iOS client and no deployment yet.

Build a personal, mobile-first podcast player on this server, with an API that a future native iOS app can reuse. The central interaction is one tap to capture a coherent thought from the preceding 30 seconds–3 minutes. Every new snip automatically gets a public link containing its own playable recording, transcript, and segment summary, including snips from private feeds.

The recommendation is a React web app, a TypeScript API and background worker, SQLite, and local audio storage behind the server's existing nginx/systemd setup. The processing path is server cron, hosted transcription through ElevenLabs Scribe v2 (decided October 21, 2026; local Whisper remains a per-feed fallback adapter), and Codex transcript analysis through the owner's subscription. Benchmark subscription usage before committing to capacity; keep the processing adapters replaceable.

Confirmed requirements:

- The current podcast app is **Snipd**, and the library includes **private feeds**.
- Daily cron routines use the owner's Codex subscription for analysis, with server workers pulling feeds and preparing transcripts. Keep the backend contract portable to other AI apps.
- Episodes have transcripts and AI-generated chapters that seek the player.
- Snips choose a relevant contiguous segment automatically, support clip-only playback, and allow timestamp edits.
- **Creating a snip automatically publishes its public link. No separate Share action or approval step is required.** This applies to private-feed episodes too.
- Completed episodes can have their own shareable pages.
- The app runs on this server; a native iOS companion follows.

| Document | What it resolves |
| --- | --- |
| [Core specification](core/README.md) | The minimal data model, the six core functions with contracts and eval plans, and the architecture decisions that matter for iOS. **Start here.** |
| [server/](../server/README.md) | How to run the API and worker, configuration, the route list, and how a snip flows through the jobs |
| [evals/](../evals/snip-selection/README.md) | Eval layout per function; the Readwise export of the owner's existing snips and what it says about snip length |
| [Product and screen flows](product.md) | Listening, snipping, editing, automatic publication, and episode sharing |
| [Research and Snipd inspiration](research.md) | Verified product patterns, migration limitations, transcription options, and reuse choices |
| [Architecture and processing](architecture.md) | Audio alignment, AI pipeline, app-independent routines, data model, API, hosting, and iOS path |
| [Codex routines and inference split](codex-routines.md) | Subscription-backed automation, local transcription, runtime clip processing, and capacity checks |
| [Delivery plan and costs](delivery.md) | Milestones, acceptance criteria, cost scenarios, and remaining decisions |

The first implementation milestone should prove the complete path on one public and one private episode: acquire a stable recording, transcribe it, create chapters, play it on an iPhone, tap Snip, and open the automatically published clip in a signed-out browser. This tests the difficult parts before expanding the library or polishing every screen.

Two findings shape the plan. First, a downloaded recording must be the shared reference for playback and all timestamps; changing ads can change an episode's timeline. Snipd documents this underlying playback problem. Second, Snipd documents Markdown export of highlights, but a supported subscription export or account-sync API was **not verified** in the reviewed official sources. Importing subscriptions and importing old highlights are separate migration tasks. [Snipd on dynamic ads](https://support.snipd.com/en/articles/10226286-random-jumps-during-playback), [Snipd highlight export](https://support.snipd.com/en/articles/10226246-export-your-snips-to-markdown-and-other-apps).

Working assumptions: one owner initially; process newly discovered episodes going forward; back-catalog processing is selectable; local speech-to-text must pass a throughput/quality benchmark; retain source recordings for saved snips so timestamps remain editable. These are proposed defaults, not additional user requirements.
