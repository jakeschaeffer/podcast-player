# Prompts

The instructions for each of the app's AI workflows live in this folder, one file per version, and [registry.json](registry.json) names the version each workflow uses. They are the production prompts, not copies: the server reads them each time it calls the model. Everything else that shapes what the model sees is in code, and each section below links to it: the message built around the content, the output schema, the retry wording, and, for long episodes, the window and merge instructions.

In the app, the profile sheet's **Prompts** screen lists each prompt's versions with their eval scores, shows a version's text and its changes from the one before, saves new versions, activates one, and runs a version's eval. Beside the score it says how each version fared in use: of the live snips it wrote a title for, how many titles you rewrote; and for Snip start, of the spans the fixed rules chose, how many you moved (`services/snipEdits.ts`, from the title log and the snips' revisions). A snip left alone is not proof it was right, since nothing records whether you looked at it, so read the count as a floor.

## What runs

| Workflow | In production | Instructions | Version recorded on |
|---|---|---|---|
| [Snip title and summary](#snip-title-and-summary) | On, for every new snip and every boundary edit | [snip-summary/](snip-summary/) | each snip revision: `summary_prompt_version`, with `summary_model` |
| [Episode preview, takeaways, and chapters](#episode-preview-takeaways-and-chapters) | On, for every transcribed episode | [episode-summary/](episode-summary/) | each episode summary: `prompt_version`, with `model` |
| [Snip start](#snip-start) | Off unless `SELECTION_MODEL=on`; fixed rules choose the span | [span-picker/](span-picker/) | the revision's `selection.picker_prompt_version` |
| [Speakers](#speakers) | On, once per transcript | [speakers/](speakers/) | the transcript's `speakers` JSON, with `model` |
| [Title judge](#title-judge) | Evals only | [title-judge/](title-judge/) | each title eval's scorecard: `judge` (`judge_v1` for v1) |

All three go through the Codex CLI. The production settings are in `.env.server.local` at the repository root, outside git: `TEXT_MODEL=codex-cli`, `CODEX_REASONING_EFFORT=low`, and Codex's default model unless `CODEX_MODEL` is set.

## Snip title and summary

One call returns the title, three to five bullets that each cite the excerpt's sentence ids (stored one per line in `summary`), and one line copied word for word from the excerpt as a pull quote (stored in `quote`; empty when none stands on its own). Versions before v3 wrote a one-to-three-sentence summary with separate claims.

- **When it runs.** The `summarize_snip` job, after a snip's span is chosen: `summarizeSnipJob` in [services/snipJobs.ts](../src/services/snipJobs.ts). A title you write always wins; the model's title is still kept as `generated_title`. Moving In or Out keeps the title, summary and quote unless the length changes by more than 10 seconds, and then the app asks first (`editSnip` in [services/snips.ts](../src/services/snips.ts)).
- **Instructions.** The active version in [snip-summary/](snip-summary/).
- **The message around them.** `buildSnipSummaryPrompt` in [core/summary/snip.ts](../src/core/summary/snip.ts): the show and episode titles, two sentences of preceding context that may not be cited, and the excerpt as numbered sentences.
- **Retry.** If the answer fails a check, `summarizeSnip` (same file) asks once more with the reasons appended.
- **What counts as a valid answer.** `SnipBulletsSchema`, the limits in `DEFAULT_SNIP_BULLETS_STYLE` (title 60 characters, at most five bullets of 140, a quote of 20 to 220 found word for word in the excerpt) and `validateSnipBullets`, all in the same file, plus the invented-name check in [core/summary/names.ts](../src/core/summary/names.ts). When both attempts fail, the title is the excerpt's first eight words and there is no summary.
- **Spec and eval.** [docs/core/05-snip-summary.md](../../docs/core/05-snip-summary.md); the title eval in [evals/snip-titles/run.ts](../src/evals/snip-titles/run.ts), with results in [evals/snip-titles](../../evals/snip-titles).

## Episode preview, takeaways, and chapters

One call returns a short preview, three to seven takeaways that cite a sentence, and chapters. This is where AI chapters come from. They are shown only for episodes without aligned publisher text: Stratechery uses the publisher's own sections as chapters, Latent Space uses these. The choice is `chaptersFor` in [services/episodes.ts](../src/services/episodes.ts).

- **When it runs.** Once per recording, through the `summarize_episode` job: `summarizeEpisodeJob` in [services/summaries.ts](../src/services/summaries.ts). The job is queued when a transcript is stored ([services/transcripts.ts](../src/services/transcripts.ts)), when publisher text is aligned ([services/publisherText.ts](../src/services/publisherText.ts)), and by `POST /v1/episodes/{id}/process` for an episode without a summary ([services/episodes.ts](../src/services/episodes.ts)). Once it has succeeded for a recording, queuing it again does nothing.
- **Instructions.** The active version in [episode-summary/](episode-summary/).
- **The message around them.** `buildEpisodePrompt` in [core/summary/episode.ts](../src/core/summary/episode.ts): show, episode, duration, language and show notes, the chapter cap, and the transcript as numbered sentences with time and speaker.
- **Long episodes.** Over about 80,000 tokens, `windowed` in the same file splits the episode into 40-minute windows, asks each for chapter proposals and notes, then makes one merge call. The window and merge instructions are written in that function, not in a file.
- **Retry.** `withFeedback` (same file) appends the reasons for one more attempt.
- **What counts as a valid answer.** `EpisodeSummarySchema` (with `WindowSchema` and `ReduceSchema` for long episodes), the limits in `DEFAULT_EPISODE_LIMITS` (chapters at least 90 seconds and at most one per four minutes, titles 50 characters, descriptions 160), and the repairs in `resolveEpisodeSummary`, all in the same file.
- **Spec.** [docs/core/06-episode-summary.md](../../docs/core/06-episode-summary.md).

## Snip start

This would let the model move where a snip starts, among candidates the fixed rules offer; the end is always fixed. It is off: v1 scored below the fixed rules on the owner's snips. Snip length is decided by `selectSpan` and `DEFAULT_SELECT_PREFS` in [core/snip/select.ts](../src/core/snip/select.ts).

- **What each version may choose from.** v1 is offered three sentences either side of the default start, as it was written for. Every later version asks for reach and is offered every sentence start up to 240 seconds before the tap (`WIDE_REACH_MS`; never before the point you began listening from). The reason is in [evals/snip-selection](../../evals/snip-selection/README.md): on the snips you re-cut, your start was among v1's candidates for 5 of 17, and among the wide ones for 16. v2 is the first written for the wide range; it is not active until a run says it earns it.

- **Instructions.** The active version in [span-picker/](span-picker/).
- **The message around them.** `makeSpanPicker` in [services/spanPicker.ts](../src/services/spanPicker.ts). For v1: the candidate ids, the length rule, and the transcript lines with candidates marked. For later versions: the range of ids it may start at, the length rule, and each line with how many seconds before the end it starts, the default and the end marked.
- **If it is ever turned on.** The picker has 8 seconds in production before the fixed rules' span is used instead. A wide-range call reads up to four minutes of transcript, so check how long the calls take before relying on it.
- **Eval.** [evals/snip-selection/run.ts](../src/evals/snip-selection/run.ts), which runs this prompt against the owner's snips.

## Speakers

One call per transcript decides, for each speaker label (S1, S2…), whether it is the show's host, a guest the host is talking with, or someone else (a clip from another show, an ad, a quote read aloud), and names it only when the show's author, the show or episode title, or the show notes say who it is. So on Stratechery the host is Ben Thompson (the feed's author), an interview's guest comes from the title ("An Interview with Palantir CTO Shyam Sankar…"), and the clips and readings in a daily update stay unnamed. Unnamed speakers show as "Host", "Guest" or "Speaker 2".

- **When it runs.** The `identify_speakers` job: `identifySpeakersJob` in [services/speakers.ts](../src/services/speakers.ts). It is queued when a transcript is stored, and for older transcripts the first time `GET /v1/transcripts/{id}/speakers` is asked (the apps ask when they show a transcript).
- **The message around the instructions.** `buildSpeakersPrompt` in [core/speakers/identify.ts](../src/core/speakers/identify.ts): show, author, episode title, the start of the show notes, and for each label its share of the words, its turns and questions, and its first four lines.
- **What counts as a valid answer.** `SpeakersSchema` and `validateSpeakers` in the same file: every label exactly once, names only from the author, titles or show notes, and no name on an "other" voice. One retry with the reasons.
- **Where it is used.** The shared pages' transcripts, the apps' transcripts and snip pages, and snip summaries, which may name the speakers it names (`speaker_names`).

## Title judge

Scores a generated snip title against the title the owner wrote, 1 to 5. Used only by the title eval ([evals/snip-titles/run.ts](../src/evals/snip-titles/run.ts)), never by the app. Scorecards record its version as `judge_v1`, `judge_v2`…

## Shared by every call

- [adapters/codex-cli.ts](../src/adapters/codex-cli.ts) joins the instructions and the message into one prompt and hands Codex the output schema in strict mode. Each call runs in an empty, read-only directory without tools, personal config, or session history.
- `delimited` in [adapters/textModel.ts](../src/adapters/textModel.ts) wraps transcript text in the tags the instructions refer to, so speech is never read as instructions.

## Related, but not a text prompt

- **Transcription keyterms.** A per-show list of words sent to ElevenLabs Scribe to steer spelling, in [adapters/elevenlabs.ts](../src/adapters/elevenlabs.ts). Set it with `PATCH /v1/feeds/{id}`; it costs 20% more per hour.

## Versions

Each prompt's folder holds one file per version (`v1.md`, `v2.md`, and so on), never edited once written. [registry.json](registry.json) names each prompt's active version and records every version's creation time and the hash of its file. The server reads the registry on every model call, so activating a version takes effect on the next call without a restart, and every output records the version that wrote it.

From the app, a new version is saved as the next file and an activation changes the registry; the server commits each change to git in the checkout it runs from, and commits each eval run's scorecard the same way. From code, add the next `vN.md`, add its entry to the registry (`created_at` and the file's `sha256`), and set `active` when it should go live.

[test/prompts.test.ts](../test/prompts.test.ts) fails when a version file changes after it was created, or when the part of a prompt built in code changes: the message around the content, the retry wording, the output schema. When that change is intended, record the new fingerprint the test prints, then create and activate a new version so outputs from before and after stay apart.

New snips and edits use the active version; existing snips keep the one they were made with. Existing episode summaries are not redone either: the job runs once per recording, so only episodes summarized for the first time get a new version.

History: `git log -p -- server/prompts` for the instruction files and activations, and for code-built parts, for example `git log -L :buildSnipSummaryPrompt:server/src/core/summary/snip.ts`.

## Evals

| Prompt | Eval | A case passes when | Cases |
|---|---|---|---|
| Snip summary | [Titles](../src/evals/snip-titles/run.ts) | the judge says the title makes the owner's point (4 or 5 of 5); a title that fails validation fails | 60 of the owner's titles, seeded, with every title rewritten in the app first |
| Snip start | [Starts](../src/evals/snip-selection/run.ts) | both boundaries land where the owner's snip did, so no edit is needed | 510 simulated taps on 102 Stratechery snips from Readwise, and every snip made in the app: its real tap, and the span you left it with ([appSnips.ts](../src/evals/snip-selection/appSnips.ts)) |

Each run's score is the share of cases that pass, with the half-width of its 95% interval. Runs started from the app use these case sets, so a version's score is comparable with earlier versions' as far as the sets are the same: both grow with what you do in the app (titles you rewrite, snips you make), and a run's scorecard says how many of each it had. From the command line, `--version vN` runs a version other than the active one: `pnpm --dir server eval:titles:run --version v2`, or `pnpm --dir server eval:snips:run --model --version v2`. The episode summary has no eval yet.

## Seeing what the prompts produced

- **Snip titles and summaries.** Recent outputs with their versions, from the repository root:

  ```bash
  node -e 'const {DatabaseSync}=require("node:sqlite"); const db=new DatabaseSync("data/app.db",{readOnly:true}); console.table(db.prepare("SELECT summary_prompt_version AS version, summary_model AS model, title, summary FROM snip_revision WHERE summary_status = ? ORDER BY created_at DESC LIMIT 10").all("ready"))'
  ```

  `GET /v1/export/title-edits` lists every title you rewrote next to the model's title and the prompt version that wrote it.
- **How often you changed them.** `GET /v1/prompts` carries each snip-summary version's `edits` (`snips`, `edited`) and Snip start's `rules_edits`, the same counts the Prompts screen shows.
- **Episode summaries.** `GET /v1/episodes/{id}` returns `summary.prompt_version`, `summary.model`, the preview, the takeaways, and `chapters.source` (`publisher` or `ai`).
