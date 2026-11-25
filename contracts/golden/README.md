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
| `speakers/speaker_names_v1.json` | `server/src/core/speakers/identify.ts` | The heading a speaker label shows under (speech recognition's `S1`, publisher text's names and `Quote`, none), and a clip's turns on the snip pages. The web app's `speakerName` and the native app's `Speaker.displayName` / `clipTurns` replay it |
| `summary/snip_summary_validation_v2.json` | `server/src/core/summary/snip.ts`, `names.ts` | The bulleted summary (snip-summary v3 on): the validator's problem strings, bullet clean-up, and the key the word-for-word quote check compares. v1 still covers excerpts, fallback titles and the name guard |
| `transcript/normalize_v1.json` | `server/src/core/transcript/types.ts`, `normalize.ts` | The stored transcript for a provider's raw words (`normalize_v1`: which words are dropped, rounding and clamping of times, speakers, where segments split, events), the option combinations it refuses, which endings close a sentence, word slices, speaker turns, and every code point `trim` removes |
| `transcript/align_v1.json` | `server/src/core/transcript/tokens.ts`, `align.ts` | `normalizeToken` (with every code point that survives it), and the banded word alignment: the edit script, the matched pairs and the error counts, inside the band and where the two sequences drift out of it |
| `selection/sentencizer_v1.json` | `server/src/core/snip/sentencize.ts` | Sentences (`sentencizer_v1`) beyond the ones in `select_v2.json`: the merge rule for short fragments, every option, the 120 s margin, and transcripts no provider would produce |
| `ads/ads_v3.json` | `server/src/core/ads/detect.ts` | Ad breaks (`ads_v3`): edges, confidence, sources and cue for each signal alone and together (speech the publisher's text lacks, sponsor phrases, ad chapters), every phrase the detector knows with near misses, how overlapping signals merge, and every option |

Transcripts inside the files use the API shape (`GET /v1/transcripts/{id}`): segments `{s, e, spk, w0, words}` with
words as `[start_ms, end_ms, text]` tuples and `w0` the global index of a segment's first word. A port reads one back
as the generators do (`fromApiTranscript` in `server/test/helpers/transcript.ts`): a segment's `idx` is its position
and its `text` its words joined by single spaces. `transcript/normalize_v1.json` is the exception: what it expects
is the transcript as stored (`idx`, `start_ms`, `end_ms`, `speaker`, `first_word`, `text`, `words`), because every one
of those fields is part of the answer.

The Swift ports live in `ios/Packages/PlayerKit` (heard tracking, In/Out rules), `ios/Packages/PodcastAPI` (speaker
names) and `ios/Packages/SnipCore` (transcripts, sentences, alignment, ad detection); `ios/scripts/test.sh` replays
the files against them.

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
  under a new version, never in one port alone. The ad detector's quirks are the last entry below.
- **String equality is code units.** `===`, `!==` and `Map` keys compare the units of a string; Swift's `==` and
  `Dictionary` call two strings equal when they are canonically equivalent ("é" as one code point, or as "e" plus a
  combining accent). Two speaker labels or two tokens that differ only that way are different to the reference, so
  compare `utf8` views and key dictionaries by bytes. A test that compares answers with `==` has the same blind
  spot: compare the encoded bytes.
- **`Math.round` sends a half up**, toward positive infinity: 2.5 is 3 and -2.5 is -2. Swift's `rounded()` sends a
  half away from zero, and `(x + 0.5).rounded(.down)` is wrong for 0.49999999999999994.
- **`trim` has its own list of whitespace**: it removes the byte order mark (U+FEFF) and not the next-line
  character (U+0085) or the zero width space, where Foundation's `.whitespacesAndNewlines` differs.
  `normalize_v1.json` lists all 25 code points.
- **`toLowerCase` reaches two letters beyond ASCII.** `normalizeToken` lowercases and then keeps `[a-z0-9']`, so
  the dotted capital I (U+0130, which lowercases to "i" plus a combining dot) becomes "i" and the Kelvin sign
  (U+212A) "k"; nothing else outside ASCII survives. `align_v1.json` lists every surviving code point.
- **Regular expressions.** `$` without the `m` flag matches only at the very end; ICU's (Foundation's) also matches
  before a final line end. `\b` and `\w` are ASCII: an apostrophe is a word boundary ("sponsor's" holds the word
  "sponsor"), which Swift `Regex` gets wrong by default (it uses Unicode word boundaries) and ICU gets right.
  `/i` without the `u` flag folds ASCII letters only: a long s (ſ) is no "s", a dotted capital I no "i". A class
  such as `[.!?…]` matches a code point, not a Swift `Character`: a full stop followed by a combining accent is not
  a full stop at the end.
- **There are two sentence-end rules.** `endsSentence` (the normalizer and the sentencizer) counts a curly
  apostrophe among the closing quotes after a full stop; the ad detector's own rule, used for the edges of a
  sponsor read, does not.
- **A backwards range is empty in JavaScript.** `slice(6, 5)` and a `for` loop from 6 below 5 give nothing; a Swift
  range traps. `speakerTurns` takes any range, and the files ask for backwards ones.
- **Numbers JSON cannot write.** A raw word's or event's time may be NaN or infinite (the normalizer drops such
  words). The files write those as the strings `"NaN"`, `"Infinity"` and `"-Infinity"`. Raw times are fractional;
  everything a function returns is whole milliseconds, compared as integers.
- **The aligner outside its band.** When the true alignment strays from the scaled diagonal by more than the band
  (600 words by default), `alignTokens` does not fail: its backtrace reads the table at an index that belongs to another cell, or
  past the table's end, where a JavaScript typed array gives `undefined` and the step becomes an insertion. The
  answer is poor but defined, and the files hold such cases, so a port keeps the one flat table and the same index
  arithmetic, and treats a read outside it as an insertion instead of trapping.
- **Ad detection's quirks** (all in `ads_v3.json`): signals of one kind that merge into one break keep the end of
  the *first* of them (the first chapter, gap or read), not the latest end; a strong sponsor phrase within 90 s of a recording's last word,
  with no other end to its read, runs the break to the end of the recording, a chapter's own end notwithstanding;
  a music event that starts while a word is being spoken never ends a read; an event label only has to contain
  the letters ("testing" is a sting); and the address phrase matches ordinary words that end like one ("go to
  Mexico").
