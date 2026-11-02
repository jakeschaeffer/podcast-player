# 2. Snip selection

**Contract:** given a tap at anchor `T` on an asset, return one contiguous span `[start, end)` of audio the listener has already heard that contains one complete idea, within 30 to 180 seconds unless the window is shorter. Return it fast, return it deterministically when the model is unavailable, and never return audio from after the tap or from before a seek.

This is the function the product lives or dies on, so it is specified as a pure function with an explicit candidate space, a scoring baseline that needs no model, and a model step that can only choose among validated candidates.

## Pure core

```ts
selectSpan(input: {
  transcript: Transcript | null,
  anchor_ms: number,            // T
  heard_from_ms: number,        // H, from the player engine
  duration_ms: number,          // asset length
  prefs: { min_ms: 30000, max_ms: 180000, target_ms: 90000, tail_pad_ms: 250, lead_pad_ms: 200, snap_band_ms: 0, model_start_radius: 3 },
  model?: TextModel,            // optional; absent in the fallback path and in most unit tests
}): Promise<Selection>

type Selection = {
  start_ms: number; end_ms: number;
  start_word: number | null; end_word: number | null;   // [start_word, end_word)
  method: 'model' | 'snap' | 'heuristic' | 'fixed';     // heuristic = scored inside a non-zero band
  window: { lo_ms: number; hi_ms: number; short_exception: boolean; min_relaxed: boolean };
  sentences: Sentence[];        // what the model saw, for evals and debugging
  eligible_end_ids: number[];
  candidates: ScoredCandidate[];
  snap: { start_id: number; end_id: number } | null;    // the deterministic choice before any model adjustment
  chosen: { start_id: number; end_id: number; reason: string } | null;
  model_rejection: string | null;
}
```

## Algorithm

**Step 1, the window.** `lo = max(0, T − max_ms, H)` and `hi = T`. If `hi − lo < min_ms` the short exception applies: the minimum is waived and the UI shows the real duration. A word counts as heard when its `end_ms ≤ T`.

**Step 2, sentences.** Take the segments overlapping `[lo, hi]` and split them into sentences deterministically: on terminal punctuation from the transcriber, on a pause of 700 ms or more between words, and on every speaker change. Merge same-speaker fragments shorter than three words into their predecessor; a short interjection by another speaker ("Right.") stays separate because step 3 needs it. The sentencizer works on a two-minute margin around the window so a window edge never cuts a sentence into a fragment. Sentences get ids `0..n−1` in order and carry `speaker`, `start_word`, `end_word`, `start_ms`, `end_ms`, and `text`. The sentencizer is versioned (`sentencizer_v1`) because evals depend on it; its output is never stored.

**Step 3, the end.** The end is the latest sentence that finishes at or before `T`. A sentence of fewer than four words by a different speaker than the preceding full sentence ("Right.", "Yeah.") is an interjection and is skipped; a short sentence by the same speaker is the end of their thought and is kept. Reaction delay means the idea usually finished one to five seconds before the tap. The next two eligible ends are recorded for the eval log but not used.

**Step 4, the start.** Every sentence start that gives a duration inside `[min_ms, max_ms]` (or anything inside the window under the short exception; or, when no sentence-aligned span reaches the minimum, the longest available span, flagged `min_relaxed`) is a candidate. The default start is the candidate whose duration is nearest `target_ms`, 90 seconds. That is the whole deterministic rule in version 2. The scored signals below are only consulted among candidates within `snap_band_ms` of the nearest distance, and the production default sets that band to zero, because the owner's own snips showed the signals hurting on monologue shows (see the baseline note at the end of this page).

| Signal, used only inside the band | Score |
| --- | --- |
| Start sentence begins a speaker turn | +3 |
| Start sentence is a question answered by a different speaker | +3 |
| Start sentence is a question with no speaker change, or begins with a framing phrase ("So", "The thing is", "Here's", "What I found") | +2 |
| Pause of 1.5 s or more before the start | +2 |
| Duration within `good_min_ms` to `good_max_ms` (60 to 150 s) | +1, then −1 per 30 s beyond |
| Start sentence begins with a continuation ("And", "But", "Because", "Which") or a bare pronoun | −3 |

**Step 5, the model.** When a text model is configured, it is offered the default start and up to three candidate sentences on either side of it, with the end marked as fixed, and asked for one start id and a reason. It never chooses the end, never sees or emits milliseconds, and a pick outside the offered set falls back to the default with the rejection reason kept for the eval log. The call has an 8 second budget in production.

**Step 6, padding to audio.** `start_ms = max(lo, start_word.start_ms − lead_pad, previous_word.end_ms)` and `end_ms = min(T, last_word.end_ms + tail_pad, next_word.start_ms)`. The padding can never include a syllable of a neighbouring word or cross the window.

**No transcript.** When the asset has no transcript yet, return `method: 'fixed'`: `[max(lo, T − target_ms), T]` with null word indices. The revision is created in `status: 'waiting'`, a priority-100 `transcribe` job is enqueued, and the selection re-runs when the transcript lands. The owner sees the fixed range immediately; the public page shows "preparing" until the real selection, excerpt, and summary exist.

**Playback speed** never enters the function. Everything is in asset time.

## Manual edits

`PATCH /v1/snips/{id}` accepts either `{ start_word, end_word }` from the transcript editor or `{ start_ms, end_ms }` from the numeric fields. Millisecond edits snap to the nearest word boundary unless `snap: false` is sent. The excerpt is recomputed as the words whose midpoint lies inside the range. The result is a new revision with `method: 'manual'`, which re-renders the clip and re-summarizes (functions 3 and 5). The 30 to 180 second rule does not apply to manual edits; only `0 ≤ start < end ≤ duration` does.

Every manual edit of an automatically selected span is logged as `(auto selection, final selection)`. That log is the eval set growing itself.

## Evals

Case format (`evals/snip-selection/cases/<id>.json`):

```json
{
  "id": "founders-ep212-tap07",
  "transcript_fixture": "fixtures/founders-ep212.transcript.json",
  "anchor_ms": 1122000, "heard_from_ms": 985000, "speed": 1.5,
  "label": {
    "idea": "why the first pricing experiment failed",
    "ideal_start_word": 3011, "ideal_end_word": 3104,
    "acceptable_start_ms": [1079000, 1090000],
    "acceptable_end_ms": [1115000, 1122000]
  },
  "tags": ["reaction-delay", "2x"]
}
```

Tags to cover, with at least five cases each: `mid-sentence` (tap during a sentence), `reaction-delay` (tap 3 to 8 s after the idea ends), `episode-start`, `post-seek`, `silence-before`, `cross-talk`, `2x`, `long-monologue` (idea longer than 180 s), `short-exchange` (idea shorter than 30 s), `question-answer`. Target 40 cases before the first implementation, labelled by the owner with a small labelling page that plays the window and lets them mark the ideal start and end.

Metrics per run, per method (`fixed-60`, `fixed-90`, `heuristic`, `model`):

| Metric | Definition | Target |
| --- | --- | --- |
| Start hit | `start_ms` inside `acceptable_start_ms` | – |
| End hit | `end_ms` inside `acceptable_end_ms` | – |
| No edit needed | both hits | ≥ 80% |
| IoU | overlap of chosen and ideal span over their union | report |
| Over-capture | milliseconds before `ideal_start` included | report p50/p95 |
| Under-capture | words of the ideal span excluded | report p50/p95 |
| Invariant violations | any span outside the window, after `T`, or breaking the duration rule | 0 |
| Fallback rate | share of `method == 'fixed'`, plus the model rejection rate when a model was configured | report |
| Latency | wall time of `selectSpan` | p95 ≤ 8 s with model, ≤ 50 ms without |

Invariants also run as unit tests over random anchors on every fixture transcript: the chosen span is always inside `[lo, hi]`, never extends past `T`, obeys the duration rule or the short exception, and the padded `start_ms`/`end_ms` never include a neighbouring word.

The first result to record is the heuristic baseline against the fixed baselines. The model step earns its latency only if it beats the heuristic on "no edit needed" by a margin the owner can feel.

**First baseline, October 21, 2026** (510 cases derived from the owner's Stratechery snips in Readwise; details in [evals/snip-selection/README.md](../../evals/snip-selection/README.md)): acceptable end found 85 to 93% of the time by every sentence-aware method; acceptable start found 16% by the scored heuristic, 33% by a fixed 90 second window, and 36% by snapping to the sentence start nearest 90 seconds back. "No edit needed": 13%, 27%, and 34%. The scoring table above is therefore not yet earning its keep on monologue shows. Version 2 (above) made the 90 s snap the default and scored 35%. The start-only model step on top of it scored 27%: it moved 70% of starts, mostly earlier, and lost more hits than it gained against these Snipd-derived labels, so model-assisted selection ships off by default (`SELECTION_MODEL=off`) until a human-labelled set exists to judge it on.
