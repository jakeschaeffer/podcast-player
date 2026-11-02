# Golden cases for the shared snip algorithms

The snip workflow runs in three places: this repo's server and web app (TypeScript), the native podcast app,
and the audiobook app (`audiobooth-fork`), both Swift. The algorithms below must give **identical answers
everywhere**, or a snip taken on the phone would differ from one taken on the web. Each JSON file here holds
inputs plus the answers the TypeScript reference gives. A Swift port loads the file, replays every case, and must
reproduce every expected value. This is the contract; see `docs/cross-repo-snips-plan.md`, Part 3.

| File | Reference implementation | What a port must reproduce |
| --- | --- | --- |
| `heard/heard_v1.json` | `web/src/player/heard.ts` | `heard_from` and the merged heard ranges after each step (reset, position ticks, deliberate jumps) |
| `span-points/span_points_v1.json` | `web/src/lib/spanPoints.ts` | Where In/Out land when set or nudged, when the other point is carried along, which words count as inside a span |
| `selection/select_v2.json` | `server/src/core/snip/sentencize.ts`, `select.ts` | Sentences (`sentencizer_v1`), the chosen span and decision record (`select_v2`, no model), midpoint word ranges |
| `summary/snip_summary_validation_v1.json` | `server/src/core/summary/input.ts`, `snip.ts`, `names.ts` | The excerpt's sentence ids and context lines, the validator's problem strings (exactly: they are reprompt text), fallback titles, sentence counts, the name guard |
| `summary/snip_summary_validation_v2.json` | `server/src/core/summary/snip.ts`, `names.ts` | The bulleted summary (snip-summary v3 on): the validator's problem strings, bullet clean-up, and the key the word-for-word quote check compares. v1 still covers excerpts, fallback titles and the name guard |

Transcripts inside the files use the API shape (`GET /v1/transcripts/{id}`): segments `{s, e, spk, w0, words}` with
words as `[start_ms, end_ms, text]` tuples and `w0` the global index of a segment's first word.

## Rules

- **Inputs are synthetic.** Never put real book text, private-feed transcripts, or listening history here; this
  folder may be published.
- **The TypeScript tests keep the files honest.** `web/test/*.golden.test.ts` and `server/test/golden-*.test.ts`
  regenerate every answer and fail if a committed file differs. Re-record with `UPDATE_GOLDEN=1 pnpm -r test`.
- **A behaviour change is a new version, not an edit.** Changing what a reference returns means a new version
  string (`select_v3`, `heard_v2`), a new file next to the old one, and both implementations updated. The old file
  stays so old evals remain reproducible. Re-recording an existing version is only for adding cases or fixing a
  case that was wrong in the generator.

## Porting traps (each has cases in the files)

- **String length is UTF-16 units.** The 60/320 limits count what JavaScript's `.length` counts: in Swift use
  `.utf16.count`, not `.count` (an emoji is 2 units, one `Character`).
- **Midpoints are fractional.** `(start + end) / 2` is a float in JavaScript; in Swift convert to `Double` before
  dividing.
- **Regex classes.** The name guard uses Unicode letter classes (`\p{L}`, `\p{Lu}`, `\p{Ll}`) and treats curly
  apostrophes as letters; JavaScript's `\s` matches the non-breaking space.
- **Sentence ids are positions** in the list a function returns (0, 1, 2…), not stored ids. An excerpt's ids
  restart at 0.
- **The sentencizer reads 120 s beyond the requested range** on both sides. A caller that passes only a window must
  include that margin, or the sentence playing at the tap looks finished.
- **Comparators.** Both languages sort stably; but a JavaScript comparator returns a number and a Swift one a strict
  "comes before" Bool (`<`, never `<=`).
- **Known quirks are part of the contract.** `countSentences` splits after abbreviations ("Dr. Smith arrived. He
  sat." is 3), and an excerpt clipped mid-sentence keeps the clipped words. Fix such things in the TypeScript
  under a new version, never in one port alone.
