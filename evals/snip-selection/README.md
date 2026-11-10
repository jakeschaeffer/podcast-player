# Snip selection evals

Cases, fixtures, and results for function 2 ([spec](../../docs/core/02-snip-selection.md)). Fixtures are gitignored because they contain the owner's listening history and private-feed content.

## What is here

| Path | Contents | In git |
| --- | --- | --- |
| `fixtures/readwise/` | The owner's 1,016 podcast highlights exported from Readwise on October 21, 2026: 671 unique Snipd snips with transcript text and a start offset in seconds, plus 199 older Airr quotes. See its README for the field inventory | no |
| `cases/` | Eval cases in the format below, derived from the Readwise snips once the matching episodes are transcribed | no (private text); the generator script will be |
| (the database) | Cases from the snips made in the app, read at run time | no |
| `results/` | Dated scorecards per selector version | no |

## Two kinds of case

- **Readwise snips** (below): the owner's Snipd library, each snip's words aligned to our transcript, with the tap simulated at five places in its last sentence. Many cases, one show's worth of episodes, no real taps.
- **Snips made in the app** (`server/src/evals/snip-selection/appSnips.ts`): every live snip whose span a selector chose from a transcript. The case has the real tap (`anchor_ms`, `heard_from_ms`) and the transcript the selector saw, and its label is the span the owner left the snip with. They are read from the database when a run starts, so nothing is built or stored, and the set grows as snips are made. `pnpm --dir server eval:snips:run --app` adds them (set `DATA_DIR` to the database's folder, as `scripts/dev-server.sh` does); a run started from the Prompts screen always includes them. With no Readwise export they are the whole eval.

A snip whose boundaries the owner moved is exact ground truth (`app:edited`, with `app:start-earlier`, `app:start-later`, `app:end-moved`). One left alone (`app:left-alone`) is weaker: nothing records whether it was looked at. It still counts, because it shows what a new selector would change that nobody asked for. Read the two groups apart: a better selector raises the first without lowering the second. Scoring only the edited snips would flatter any change, since they are by construction the ones the current rule got wrong.

### Baseline on the app's snips, November 9, 2026

48 snips across nine shows; the owner moved boundaries on 17: the start earlier on 11 (median 69 s), later on 4, and the end on 8. Selector `select_v2`, no model.

| Method | Both, all 48 | Left alone (31) | Edited (17) | Edited: start hit | Edited: end hit |
| --- | ---: | ---: | ---: | ---: | ---: |
| snap-90 (production) | 63% | 97% | 0% | 4 of 17 | 11 of 17 |
| fixed-90 | 10% | 13% | 6% | | |
| fixed-180 | 2% | 0% | 6% | | |
| snap-90-band15 | 35% | 55% | 0% | | |
| scored-v1 | 17% | 23% | 6% | | |

What it says: the production rule reproduces what it chose (the one miss was chosen by `select_v1`), and no other length or scoring fixes more than one of the edited snips, because the starts the owner wants sit anywhere from 38 to 240 s before the tap. Three are past the 180 s ceiling, which no setting of the current selector can reach, and the model start picker may move only three sentences from the default. A start chosen from the content, over a wider range, is what these cases can now measure.

### What a start picker could reach, November 10, 2026

The scorecard's two ceilings are a picker that knows the label and takes an offered start inside the acceptable range whenever there is one. No prompt can score above its ceiling. Same 48 snips, no model:

| Method | Both, all 48 | Left alone (31) | Edited (17) | Start hit, all 48 |
| --- | ---: | ---: | ---: | ---: |
| snap-90 (production) | 63% | 97% | 0% | 71% |
| ceiling-near: v1's candidates, three sentences either side of the default | 67% | 100% | 6% | 75% |
| ceiling-240s: every start within 240 s, offered to versions after v1 | 85% | 100% | 59% | 98% |

So the v1 prompt could never have fixed more than one of the 17 however it was worded: the owner's start was among its candidates for 5 of them, and the end was right for only one of those. With every start in the rules' 180 s on offer it is 13 of 17, with 240 s it is 16, and 300 s adds none, which is why `WIDE_REACH_MS` is 240 s. What the wide ceiling still misses is the end: the selector ends at the tap, and the owner moved the end on 8 of the 17, mostly later. Whether a prompt gets near its ceiling, and what it does to the 31 nobody touched, takes a model run to say.

### span-picker v2 on the same snips, November 10, 2026

The first model run with the wide reach: `--app --model --version v2`, Codex CLI at low reasoning effort, run from the Mac. All 48 picks were valid ids (none rejected, none failed).

| Method | Both, all 48 | Left alone (31) | Edited (17) | Start hit, all 48 |
| --- | ---: | ---: | ---: | ---: |
| snap-90 (production) | 63% | 97% | 0% | 71% |
| snap-90 + span-picker v2 | 27% | 16% | 47% | 29% |
| ceiling-240s | 85% | 100% | 59% | 98% |

What it says:

- **It can find the owner's start.** 8 of the 17 edited snips need no edit, of the 10 the ceiling allows; on the 11 whose start the owner moved earlier it is 6 against the ceiling's 8. The rules get none.
- **It moves far too often.** It kept the default start on 5 of 48, started earlier on 35 (median 51 s earlier) and later on 8 (median 28 s later). The owner moved the start earlier on 11 and later on 4. So it changed 28 of the 31 snips nobody touched, 25 of them past the one-sentence slack, 24 of those earlier, and the median clip grew from 90 s to 126 s. A left-alone snip is a weak label, so 16% overstates the harm, but a picker that rewrites nine in ten of the spans the owner accepted is not one to turn on. The prompt reads "where does this thought begin" as an invitation to go back; a next version has to make the default the answer unless there is a reason against it, and be scored on both groups.
- **It is far too slow to run at the tap.** Seconds per call: median 32, p90 46, longest 61, with four calls at a time on a laptop. The production picker gives up after 8 s (`makeSpanPicker`'s default) and the rules' span stands, so 47 of these 48 picks would have been thrown away. A start chosen by a model this way has to be chosen before the tap (per episode, after transcription) or by a much faster call.

## What the Readwise export says about snip length

Word counts of the transcript part of the owner's Snipd snips (deduplicated, 644 snips): min 43, p25 272, median 394, p75 587, p90 702, max 1,315. At typical speech rates that is a median of roughly 2.5 minutes and a p75 near 4 minutes, with a downward trend by year (median 579 words in 2023, 272 in 2026). Two consequences for the selector:

1. The 30 to 180 second automatic window is at or below the owner's historical median. Treat the ceiling as a tuning parameter the eval decides, not a fixed rule; a 240 second ceiling is the first alternative to measure.
2. Snipd snips often end mid-sentence because Snipd cuts at the button press. The owner's instruction for building cases: **assume the button was pressed within the last sentence of the Readwise snip.**

## Turning a Readwise snip into a case

For each Snipd snip whose episode is in the library with a transcript:

1. Align the snip's transcript text to our word-timed transcript (fuzzy match on normalized words; the Readwise `location` start offset narrows the search to a window of about ±90 seconds).
2. `ideal_start_word` and `ideal_end_word` come from the alignment. `acceptable_start_ms` spans from one sentence before to one sentence after the aligned start; `acceptable_end_ms` spans the aligned last sentence.
3. Generate several anchors per snip inside the last aligned sentence (at 25%, 50%, 75%, and 100% of the way through it, plus 3 seconds after its end for reaction delay). Each anchor is a case with `heard_from_ms = 0` unless the owner's listening history says otherwise.
4. Tag the case with the show, the year, the snip's word count bucket, and whether the snip ends mid-sentence.

Scores to report per selector version: start hit, end hit, both ("no edit needed"), IoU, over- and under-capture, fallback rate, latency, and the same for the fixed 60 s, 90 s, 180 s, and 240 s baselines. Group by word-count bucket, because the heuristic's duration preference and the owner's actual habit differ.

## Baseline recorded October 21, 2026

Built by `pnpm --dir server eval:snips:build` and scored by `pnpm --dir server eval:snips:run` (with `--model`, `--version vN` scores a start-picker prompt version other than the active one, and the app's Prompts screen runs the same model eval on any version); the full scorecard with per-group tables is `results/2026-10-21T18-26-10-selection.md`.

Inputs: 116 Stratechery snips from Readwise, 11 without transcript text, 2 below the 70% alignment coverage bar, 1 unalignable, leaving 102 snips across 53 episodes, each with 5 anchors (25%, 50%, 75%, 100% of the last sentence, and 3 seconds after it): 510 cases. Transcribing the 62 matching episodes (32.4 hours) cost $7.44.

| Method | Start hit | End hit | Both (no edit) | Mean IoU | Median duration s |
| --- | ---: | ---: | ---: | ---: | ---: |
| fixed-60 | 5% | 80% | 4% | 0.63 | 60 |
| fixed-90 | 33% | 80% | 27% | 0.77 | 90 |
| fixed-180 | 6% | 80% | 5% | 0.51 | 180 |
| fixed-240 | 0% | 80% | 0% | 0.40 | 240 |
| heuristic-180 | 16% | 85% | 13% | 0.67 | 71 |
| heuristic-t90 | 13% | 84% | 11% | 0.69 | 94 |
| snap-90 | 36% | 93% | 34% | 0.75 | 90 |
| snap-100 | 15% | 93% | 14% | 0.72 | 100 |

What it says:

- **Ends are mostly solved deterministically.** Every sentence-aware method hits the acceptable end range 85 to 93% of the time, including taps 3 seconds after the idea ended, which the fixed methods always miss.
- **Starts are the problem, and the scoring rules hurt.** The scored heuristic (speaker turn, question, framing, pause, continuation penalty) finds an acceptable start 16% of the time. Dropping the scoring and simply snapping to the sentence start nearest 90 seconds back (`snap-90`) gets 36%, the best deterministic result. Stratechery is a monologue, so the turn and question signals never fire and the continuation penalty steers away from starts that begin with "And" or "But", which are common in this prose.
- **The owner's Stratechery spans are tightly clustered around 90 seconds** (p25 75 s, median 88 s, p75 99 s; only 7% exceed 180 s). This is why `fixed-90` beats everything except `snap-90` and why `snap-100` is far worse than `snap-90`. The clustering most likely reflects Snipd's automatic length rather than deliberate choices, which is the main caveat on this set: it measures agreement with Snipd's behaviour on snips the owner kept, not an independent human ideal. The spec's 40 hand-labelled taps are still needed, and the model-assisted option should be judged against those.
- **The 180 second ceiling is not the constraint for this show.** Raising it to 240 or 300 seconds changed nothing.
- **Nothing deterministic approaches the 80% "no edit" target.** The best is 34%. The remaining gap is a judgment about where an idea starts, which is the case for the model step described in the spec.

Proposed next change to the production selector, pending the owner's call: make the sentence-snapped length prior the primary rule and use the scored signals only to break ties, then measure again.

### Model-assisted selection, same day

`pnpm --dir server eval:snips:run --model --concurrency 5` scored the Codex-backed span picker (the production picker in `server/src/services/spanPicker.ts`, Codex CLI default model at low reasoning effort, 90 s timeout) on the same 510 cases. Full scorecard: `results/2026-10-21T19-19-35-selection.md`. Every one of the 510 picks came back valid; none timed out or failed. The run took 692 s with five calls in flight, about 10 s per call.

| Method | Start hit | End hit | Both (no edit) | Mean IoU | Median duration s | p95 latency ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| fixed-90 | 33% | 80% | 27% | 0.77 | 90 | 0 |
| heuristic-180 | 16% | 85% | 13% | 0.67 | 71 | 0 |
| snap-90 | 36% | 93% | 34% | 0.75 | 90 | 0 |
| model-180 (codex/low) | 24% | 68% | 18% | 0.65 | 73 | 10140 |

What it says:

- **The model as prompted does not beat the deterministic snap.** It finds an acceptable start more often than the scored heuristic (24% vs 16%) but less often than the 90 s snap (36%), and it loses most on the end: it was free to choose among the three latest sentence ends and picked an earlier one in a third of cases, while this ground truth always ends at the tap. Fixing the end to the latest eligible sentence and letting the model choose only the start is the obvious next prompt to test.
- **It adapts length where fixed priors cannot.** On snips under 200 words it reaches 30% (every fixed and snapped method: 0 to 10%), and it is the only method with any hits on 400 to 700 word snips. On the dominant 200 to 400 word bucket it scores 17% against the snap's 49%.
- **Cost of the judgment call:** about 10 s of latency per snip on the subscription path, and roughly 15 to 20k tokens per call of which most is the CLI's own overhead. A direct API would cut latency to a few seconds.
- **The caveat from above applies with more force here.** The model picks tighter "one idea" starts (median under-capture 10.7 s against the labels); whether that is worse than Snipd's roughly-90-seconds behaviour is exactly what the owner's hand-labelled taps would settle.

### Selector version 2, same day

The recommended shape became the production selector (`select_v2`): latest sentence end with a speaker-aware interjection skip, default start nearest 90 s back, the scored signals only inside an optional band (zero in production), and the model offered at most three candidate starts either side of the default with the end fixed. The scorer now judges boundaries on the first and last selected words rather than the padded clip edges, which had been costing the production path hits for the 200 ms lead-in that the prototype did not add.

| Method | Start hit | End hit | Both (no edit) | Mean IoU | Median duration s |
| --- | ---: | ---: | ---: | ---: | ---: |
| fixed-90 | 33% | 80% | 27% | 0.77 | 90 |
| scored-v1 (old default) | 19% | 93% | 17% | 0.67 | 70 |
| snap-90-band15 (signals inside a 15 s band) | 27% | 93% | 25% | 0.74 | 90 |
| snap-90 (new default) | 36% | 93% | 35% | 0.75 | 90 |
| snap-90 + model start pick (Codex, low effort) | 29% | 93% | 27% | 0.73 | 92 |

The band variant confirms the earlier reading: letting the signals decide even among near-target candidates costs ten points on this corpus.

The start-only model step, measured on the same 510 cases (`results/2026-10-21T20-25-51-selection.md`, 532 s for 510 calls at five in flight, median 4.8 s and p95 7.4 s per call, every pick valid): it moved the start away from the snap default in 357 cases, mostly earlier (238), gaining 42 start hits and losing 81. Net, it turns 35% no-edit into 27%. Against these labels the model's judgment about where an idea begins disagrees with Snipd's roughly-90-second habit more often than it agrees, and the deterministic snap is the better production default. Model-assisted selection is therefore off by default (`SELECTION_MODEL=off`) while summaries keep using the model; the picker stays wired for the day there is a human-labelled set to judge it on. The honest reading is that this corpus cannot tell whether the model's tighter starts are worse for the owner, only that they differ from what Snipd produced.

## Case format

```json
{
  "id": "stratechery-2026-10-20-readwise-1015677674-a50",
  "transcript_fixture": "fixtures/transcripts/<asset_id>.transcript.json",
  "anchor_ms": 1122000, "heard_from_ms": 0,
  "label": { "idea": "<readwise title or first sentence>", "ideal_start_word": 3011, "ideal_end_word": 3104, "acceptable_start_ms": [1079000, 1090000], "acceptable_end_ms": [1115000, 1122000] },
  "source": { "readwise_highlight_id": 1015677674, "snipd_url": "https://share.snipd.com/snip/…", "anchor_position": 0.5 },
  "tags": ["show:stratechery", "year:2026", "words:200-400", "ends-mid-sentence"]
}
```

### Same cases, publisher-text transcripts, same day

With Updates and Articles now served from publisher text aligned by forced alignment, the cases were rebuilt against those transcripts (`pnpm --dir server eval:snips:build --transcript-source text`, scored with `--cases-dir cases-text`). On the 465 cases that exist in both sets:

| Method | ASR transcripts: no edit | Publisher-text transcripts: no edit | Start hit (ASR → text) | End hit (ASR → text) |
| --- | ---: | ---: | --- | --- |
| fixed-90 | 26% | 32% | 33% → 37% | 80% → 82% |
| snap-90 (default) | 34% | 39% | 36% → 41% | 93% → 95% |
| snap-90 with signals in a 15 s band | 26% | 32% | 28% → 34% | 93% → 95% |
| scored v1 | 18% | 15% | 20% → 15% | 93% → 95% |

Every sentence-aware method gains about five points on the cleaner text, and so does the fixed baseline, which means some of the gain is in the labels: the acceptable ranges are built from sentence boundaries, and the publisher's punctuation gives better ones than ASR's. The one loser is the old scored heuristic, whose continuation penalty fires more often on text where sentences really do start with "And" and "But".
