# Snip selection scorecard

Run 2026-10-21T21:57:44.479Z. Selector `select_v2`, sentencizer `sentencizer_v1`, cases from `cases-text`. 465 cases from 93 Readwise snips across 47 episodes.

A hit means the chosen boundary falls inside the acceptable range (one sentence of slack around the aligned Readwise boundary). IoU is against the aligned span in milliseconds. Over-capture is audio included before the ideal start; under-capture is ideal audio left out.

## Overall

| Method | n | Start hit | End hit | Both (no edit) | Mean IoU | Median over-capture s | Median under-capture s | Median duration s | Fallback | Model used | Model rejected | Model failed | Violations | p95 latency ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| fixed-60 | 465 | 8% | 82% | 7% | 0.62 | 0.0 | 31.4 | 60 | 100% | 0% | 0% | 0% | 0 | 0 |
| fixed-90 | 465 | 37% | 82% | 32% | 0.77 | 0.0 | 3.2 | 90 | 100% | 0% | 0% | 0% | 0 | 0 |
| fixed-180 | 465 | 8% | 82% | 6% | 0.53 | 89.4 | 0.0 | 180 | 100% | 0% | 0% | 0% | 0 | 0 |
| snap-90 | 465 | 41% | 95% | 39% | 0.75 | 1.2 | 5.0 | 90 | 0% | 0% | 0% | 0% | 0 | 0 |
| snap-90-band15 | 465 | 34% | 95% | 32% | 0.74 | 1.2 | 5.9 | 90 | 0% | 0% | 0% | 0% | 0 | 0 |
| scored-v1 | 465 | 15% | 95% | 15% | 0.63 | 0.0 | 25.6 | 66 | 0% | 0% | 0% | 0% | 0 | 0 |

## "Both" rate by group

| Group | n | fixed-60 | fixed-90 | fixed-180 | snap-90 | snap-90-band15 | scored-v1 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| anchor:100 | 93 | 8% | 38% | 6% | 46% | 40% | 13% |
| anchor:25 | 93 | 10% | 37% | 9% | 38% | 30% | 17% |
| anchor:50 | 93 | 10% | 42% | 10% | 38% | 30% | 17% |
| anchor:75 | 93 | 9% | 41% | 8% | 38% | 30% | 17% |
| anchor:after | 93 | 1% | 3% | 0% | 34% | 31% | 11% |
| ends-at-sentence | 255 | 9% | 33% | 4% | 38% | 36% | 19% |
| ends-mid-sentence | 210 | 5% | 31% | 9% | 40% | 28% | 10% |
| words:200-400 | 330 | 5% | 45% | 0% | 54% | 44% | 19% |
| words:400-700 | 65 | 0% | 0% | 46% | 0% | 0% | 0% |
| words:<200 | 70 | 26% | 1% | 0% | 3% | 6% | 10% |
| year:2026 | 465 | 7% | 32% | 6% | 39% | 32% | 15% |

## Mean IoU by group

| Group | fixed-60 | fixed-90 | fixed-180 | snap-90 | snap-90-band15 | scored-v1 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| anchor:100 | 0.62 | 0.79 | 0.54 | 0.79 | 0.78 | 0.64 |
| anchor:25 | 0.63 | 0.76 | 0.51 | 0.73 | 0.72 | 0.63 |
| anchor:50 | 0.63 | 0.77 | 0.52 | 0.73 | 0.72 | 0.63 |
| anchor:75 | 0.63 | 0.78 | 0.53 | 0.73 | 0.72 | 0.63 |
| anchor:after | 0.58 | 0.76 | 0.53 | 0.78 | 0.77 | 0.63 |
| ends-at-sentence | 0.65 | 0.77 | 0.49 | 0.74 | 0.73 | 0.62 |
| ends-mid-sentence | 0.58 | 0.78 | 0.58 | 0.77 | 0.75 | 0.65 |
| words:200-400 | 0.65 | 0.87 | 0.49 | 0.85 | 0.83 | 0.68 |
| words:400-700 | 0.32 | 0.48 | 0.95 | 0.50 | 0.50 | 0.38 |
| words:<200 | 0.76 | 0.57 | 0.29 | 0.53 | 0.54 | 0.61 |
| year:2026 | 0.62 | 0.77 | 0.53 | 0.75 | 0.74 | 0.63 |
