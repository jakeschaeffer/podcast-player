# 6. Episode summarization

**Contract:** given a transcript, produce one immutable `episode_summary`: a preview for lists, a set of chapters that seek the player and cover the whole episode, and a handful of takeaways with supporting words. Chapters are validated structurally before they are saved; nothing the model emits becomes a timestamp without passing through the transcript.

## Pure core

```ts
summarizeEpisode(input: {
  transcript: Transcript;             // full, with events
  metadata: { show_title: string; episode_title: string; description_text: string; language: string };
  publisher_chapters?: { start_ms: number; title: string }[];   // kept separate, shown as an alternative, never ground truth
  limits: { min_chapter_ms: 90000; target_chapter_ms: [300000, 720000]; max_chapters: (duration_ms) => Math.ceil(duration_ms / 240000) };
  model: TextModel;
}): Promise<EpisodeSummary>

type EpisodeSummary = {
  preview: string;                                                  // 2–3 sentences
  takeaways: { text: string; word: number }[];                      // 3–7, each with one supporting global word index
  chapters: { start_word: number; end_word: number; start_ms: number; end_ms: number;
              title: string; description: string; kind: 'content' | 'intro' | 'ad' | 'outro' }[];
  model: string; prompt_version: string;
}
```

## Algorithm

**Input compression.** The model sees sentences, not words: one line per sentence, `[id] [mm:ss] S1: text`, produced by the same versioned sentencizer as function 2. Audio events become lines like `[music 00:00–00:41]`. A two-hour conversation is roughly 25,000 words and 35,000 tokens in this form, which fits a single call for every model under consideration.

**Single pass up to 80,000 tokens.** One call returns `{ preview, takeaways: [{ text, sentence_id }], chapters: [{ start_sentence_id, title, description, kind }] }`. The server maps sentence ids to word indices and milliseconds. A chapter ends where the next begins; the last ends at `duration_ms`.

**Map-reduce above that.** Windows of 40 minutes with 5-minute overlap each propose boundaries and a few notes; a reduce call merges them into one outline and writes the preview and takeaways from the notes plus the first and last windows. Overlap boundaries are deduplicated by taking the earlier proposal when two fall within 60 seconds.

**Validation.** Chapters are in strictly increasing order and start at sentence boundaries; the first starts at 0; every chapter is at least `min_chapter_ms` long unless its kind is `intro`, `ad`, or `outro`; the count is at most `max_chapters`; titles are at most 50 characters and descriptions at most 160; each takeaway's sentence id exists. A violation is repaired deterministically where possible (merge a too-short content chapter into its neighbour, truncate a title) and otherwise the call is retried once with the violations listed. A second failure marks the job `failed` with the reasons, and the episode plays without chapters rather than with bad ones.

**What makes a chapter good** is in the prompt, not the validator: a title names the specific thing discussed ("Why the first pricing experiment failed"), not the activity ("Discussion", "Q&A"); a boundary sits where the topic changes, which is usually a speaker turn after a pause; ad reads and music are labelled by kind using the audio events and the content.

**Publisher chapters come first (October 28, 2026).** The episode's `chapters` are the publisher's whenever it gave any, in this order: aligned publisher text sections (`source: "publisher"`), the feed's own chapters (`"feed"`: a `podcast:chapters` JSON file fetched by the fetch_audio job or a refresh, or Podlove Simple Chapters inline in the item), timestamps in the show notes (`"shownotes"`, parsed when the episode is served and only believed when they read like a table of contents; `server/src/core/chapters/showNotes.ts`), and only then the summary's (`"ai"`). Publisher chapters start on the first transcript word at or after their time. They are not merged with generated chapters and are not used as truth in evals, because their timings refer to the publisher's edition of the file: dynamic ad insertion can make a chapter start early by the length of the ads before it, which the detected `ad_breaks` could correct later. The summary still generates its own chapters in the same call (they cost no extra call, and its `ad` chapters feed ad detection).

**Trigger.** `summarize_episode:<asset_id>` is enqueued when a transcript becomes current, at priority 0. A snip never waits on it. Re-running with a new `prompt_version` creates a new summary and moves the asset's pointer; the old one is kept for comparison.

## Evals

Reference set (`evals/episode-summary/fixtures/`): five to eight full episodes from the owner's shows, between 30 minutes and 2.5 hours, including one with mid-roll ads and one with a long single-topic monologue. The owner labels chapter boundaries once, correcting a model draft while listening at 2×, and marks each boundary as firm (a clear topic change) or soft.

| Metric | Definition | Target |
| --- | --- | --- |
| Boundary recall | Firm reference boundaries matched by a generated boundary within ±30 s | ≥ 80% |
| Boundary precision | Generated boundaries within ±30 s of any reference boundary (firm or soft) | ≥ 70% |
| Count sanity | Generated chapter count within 0.5× to 1.5× of the reference count | 100% |
| Invariants | Order, coverage, minimum length, limits, citations | 100% |
| Title quality | Owner rating 1–5 on specificity; judge rating on the same rubric | report, compare versions |
| Preview and takeaway faithfulness | Judge: each claim entailed by the cited sentence and its neighbours | ≥ 4.5 / 5 |
| Cost and time | Tokens and seconds per hour of audio, single pass versus map-reduce | report |

Invariants run as unit tests against fixture transcripts with a stubbed model that returns deliberately bad output (overlapping chapters, a chapter past the end, an unknown sentence id) to confirm the validator catches each case.

The seek test closes the loop with function 1: tapping each generated chapter on the device starts playback within one second of the chapter's first word.
