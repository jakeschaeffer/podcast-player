# Segment → title evals

Function 5 ([spec](../../docs/core/05-snip-summary.md)): given a snip's excerpt, write the title the owner would want. The reference is the owner's own title wherever one exists, from two sources:

- **Readwise**: the owner's Snipd library, exported October 21, 2026 (`evals/snip-selection/fixtures/readwise/`). Every snip with a transcript becomes a case: the excerpt as spoken turns, the show and episode, and the title.
- **This app**: every title the owner writes in the snip editor is logged with its span, its excerpt, the title it replaced, and the title the model wrote for that span (the `title_edit` table, `GET /v1/export/title-edits`). This is exact ground truth and grows on its own as snips get edited.

`pnpm --dir server eval:titles:build` writes both into `cases/` (gitignored; the cases hold transcript text), and `pnpm --dir server eval:titles:run` scores the app's title prompt against them; `--version vN` scores a version other than the active one. Results land in `results/`. The app's Prompts screen runs the same eval on any version, reading the app edits fresh from the database, and lists every run's score.

## Which Readwise titles the owner wrote

Snipd writes short Title Case headlines ("Pump Rules", "Ethereum vs. Celestia: A Comparison of Key Differences"). The owner's titles read like notes: sentence case, full stops, several sentences, numbers and shorthand, typos left in. Often they are Snipd's headline with a sentence or an aside added. A rule-based classifier (`server/src/evals/snip-titles/origin.ts`) labels each title and keeps its reasons, so a case can be checked by eye.

| Origin | Cases with a transcript | Meaning |
| --- | ---: | --- |
| Hand-written | 179 | The owner's own title throughout |
| Appended | 41 | Snipd's headline plus the owner's note; the note shows what the headline left out |
| Snipd's model | 398 | Untouched Snipd headline; a second model's opinion, not the owner's |
| Placeholder | excluded | "3min Snip" and similar |

Placeholders and snips without transcript text are left out. The classifier is a heuristic: a short, tidy title the owner typed reads as Snipd's, and a long Snipd headline with a "vs" can read as the owner's. Titles edited in the app carry no such doubt.

### What the owner adds to Snipd's headlines

| Snipd's headline | The owner's addition |
| --- | --- |
| Committee-Free ZK Bridging. | DA based shhared security vs light client (⅔+1) / Cosmos bridging. Cosmos /= shared security |
| The AI Model: Internal vs External. | The Complexity of Being an Alien Actress. |
| The Importance of the Nakamoto Coefficient for PoS Networks. | The Value of Censorship Resistance. |
| Rollups as a Service. | Using oracle rollups. |
| Improving Crypto UX with Mobile. | Solana phone experience, and Uniswap on iOS. |
| Why Decentralize Sequencers? | The answer: Liveness, Censorship Resistance, Regulatory Benefits (not a $ transmitter) |
| Shared Sequencing vs Shared Data Availability for Interoperability in Rollups. | DA is prereq, but doesn’t give interop. |
| What is Succinct? | Layer for trustless interop b/w chains by verifying consensus in execution layers. |

### A sample of hand-written titles

- Are blockchains atop Celestia L2s? No. Can rollups use Celestia as they’re sequencer? Yes, but they won’t (MEV capture). (Zero Knowledge)
- The more efficient your reconstructionis, the fewer samples you need for DA assurances (web3 with a16z crypto)
- zkVM inverts the OS <-> App relationship by making App the trusted entity (Zero Knowledge)
- Why “talk to your doctor if your erection lasts more than 4 hours” (The Peter Attia Drive)
- Overt (good) and covert (bad) contracts (Lex Fridman Podcast)
- Science is fundamentally nihilistic. Introduce arbitrary goal, then optimize around it. (Infinite Loops)
- Why build Avail when Celestia already existed? For better ZK constructions. (Zero Knowledge)
- Why do the lobbyists do it? (This Past Weekend w/ Theo Von)
- “Is it hard to verify the signature scheme of every country in the world?” (Zero Knowledge)

## Baseline, October 23, 2026

60 cases drawn with a fixed seed across shows (50 hand-written, 10 appended), titled by the app's snip-summary prompt `v1` on the Codex subscription (`codex/low`), and judged by the same model against the owner's title on a 1 to 5 scale: 5 the same point at least as specific, 4 the same point but vaguer, 3 related with a different emphasis, 2 mostly a different point, 1 wrong. Full table with every pair: `results/2026-10-23T00-38-00-titles.md`.

| Group | Cases | Mean score | Same point (4–5) | Exact (5) | Owner's words reused | Owner title, median chars | Model title, median chars |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| All | 60 | 3.61 | 63% | 8% | 17% | 85 | 47 |
| Hand-written | 50 | 3.53 | 57% | 8% | 16% | 83 | 47 |
| Appended | 10 | 4.00 | 90% | 10% | 22% | 87 | 46 |

On the appended cases Snipd's own headline scores 4.00, the same as ours. One case failed validation: the name guard mistook an ordinary capitalized word, "Obey", for an invented name.

What the misses have in common:

- **A different point from the same segment.** Snipd segments are long (median about 400 words) and hold several ideas; the owner titled the one they tapped for, and the model often titled another. Example: the owner kept "L2s are theme parks that need ride builders"; the model wrote about proof sizes and a token mentioned in the same excerpt.
- **The specific detail.** The owner's titles keep the answer, the number, the analogy, or the name ("Use cluster sets (5-20secs b/w reps)"); the model's are tidier and vaguer.
- **Length.** The owner's titles are nearly twice as long. The prompt caps titles at 60 characters, which rules out the owner's style before the model starts.

Next experiments, in the order they would be tried: a prompt that weights the end of the excerpt (where the tap was), keeps the concrete answer or number, and allows up to about 100 characters; then the same run on the owner's app edits as they accumulate. The judge is the same model family as the generator, so treat small differences between prompt versions with suspicion and read the pairs.

## Files

| Path | Contents | In git |
| --- | --- | --- |
| `cases/readwise.jsonl`, `cases/app-edits.jsonl` | Eval cases with excerpts | no |
| `results/build-*.json` | Case counts per build | no |
| `results/*-titles.md` | Scorecards with every title pair | yes |
| `results/*-titles.json` | The same scorecards with every field, for scripts | no |
| `results/title-cache.jsonl` | Cached generations and judgments, so reruns repeat no calls | no |
