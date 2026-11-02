# Transcription evals

Function 4 ([spec](../../docs/core/04-transcription.md)). Fixtures are gitignored.

`pnpm --filter @podcast-player/server transcribe <audio>` writes two files per episode into `fixtures/`: the untouched provider response (`<name>.elevenlabs.json`) and the normalized transcript in the API shape (`<name>.transcript.json`, with provenance: model, normalizer version, cost, elapsed time). `--from-raw` re-normalizes a saved response without calling the API, so segmentation rules can be iterated for free.

Baseline so far (October 21, 2026, Scribe v2): a 4.8 minute NPR newscast transcribed in 10.6 seconds for about 2 cents (788 words, 7 speakers, one tagged jingle); 62 Stratechery episodes (32.4 hours) cost $7.44 in total, about 12 cents per hour of audio. Their transcripts are in the database and, for the episodes with snips, in `../snip-selection/fixtures/transcripts/`. Hand-corrected reference clips and the WER/onset runner are the next step.

## Publisher text versus ASR, October 21, 2026

Stratechery publishes the text of every episode (in a second RSS feed, and by email). The first comparison used the email source ([server README](../../server/README.md#publisher-text-as-a-content-source)), which matched 100 newsletters to episodes with no misses; the text feed, attached afterwards, is the ongoing source and yields the same article body, and ElevenLabs forced alignment timed the text of the 58 matched episodes that have audio and a Scribe transcript (29.7 hours, 682 cents). `pnpm --dir server eval:text:compare` scored the two transcripts of each recording against each other; the full table is `results/2026-10-21T21-39-44-email-vs-asr.md`.

| Episodes | Word-start agreement, median | p90 | Within 250 ms | Mean WER, email as reference | Unread email words per episode |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 58 | 5 ms | 20 ms | 97% | 14.3% | 18 |

By episode type:

| Type | n | WER median (range) | Deletions per episode (text not spoken) | Insertions per episode (speech not in text) | Substitutions | Alignment loss |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| Updates and Articles | 38 | 9.8% (4.0 to 17.8) | 8 | 160 | 51 | 0.62 |
| Interviews | 20 | 22.6% (13.5 to 36.8) | 134 | 1,830 | 329 | 0.93 |

What it says:

- **Both timelines are trustworthy.** Where the two transcripts share a word, forced alignment and Scribe place its start within 20 ms at the 90th percentile, with no drift across an episode. Either source can drive seeking, snip boundaries, and clip rendering.
- **For Updates and Articles the email is the better text.** Almost every email word is spoken (8 unspoken words per episode, usually the section heading lines). The "errors" are on the ASR side: filler words ("you know", "uh"), numbers spelled out ("$12.9" heard as "twelve point nine"), hyphenation, and a handful of real mistakes including the show's own name ("Chartechery"). The email adds correct names, numbers, punctuation, paragraphs, and section headings with start times, which are chapters for free.
- **For Interviews the email is an edited transcript.** It drops about 15% of what was said (1,830 insertions per episode: disfluencies and cut passages) and alignment loss is higher. The Scribe transcript is the faithful record there; the email text is still useful for names and for display, but a snip excerpt drawn from it could skip speech that was cut.
- **Cost is the same as transcribing.** Forced alignment is billed at the Scribe rate, so the email path does not save money; it buys text quality and structure.

Recommended policy, not yet applied: make the email-aligned transcript current for Updates and Articles (a per-feed or per-kind preference rather than the global `PREFER_EMAIL_TEXT`), keep ASR current for Interviews, and surface `episode_text.sections` as publisher chapters so those episodes skip model chaptering. Of the 62 transcribed episodes, three are older than the 400-day window the sync searched and one inside it ("The Benefits of Bubbles", November 2025) had no newsletter matched; a wider sync window would cover the first three.
