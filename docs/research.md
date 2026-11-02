# Research and Snipd inspiration

Sources were checked on September 14, 2026. This pass used official product/help pages, provider documentation, and primary project repositories. One official Snipd product screenshot and a public snip page were inspected. It did not include a hands-on audit of the installed Snipd app, an account export, a transcription benchmark, or an iPhone playback test. Product recommendations below are our design choices, not claims about Snipd's internal implementation.

## Patterns to borrow

| Verified Snipd pattern | Proposed adaptation | Priority / evidence |
| --- | --- | --- |
| One-tap capture combines audio, transcript, and summary | Keep this as the central action in both full and mini-player | MVP; [product page](https://www.snipd.com/) |
| Transcript reading/search and AI chapters | Keep transcript, chapter list, and player on the same audio timeline | MVP; [product page](https://www.snipd.com/) |
| Auto or fixed snip duration | Default to semantic selection within the user's 30–180 second window; offer fixed capture as an override | MVP; [customizations](https://support.snipd.com/en/articles/11926947-snip-customizations) |
| Short, long, or custom summaries | Begin with concise takeaways; retain a provider-independent prompt setting for later customization | Later customization; [customizations](https://support.snipd.com/en/articles/11926947-snip-customizations) |
| Capture result appears in a sheet with editing and sharing actions | Use a dismissible result sheet while audio continues | MVP; [official product image](https://www.snipd.com/images/screen/create_snip.png) |
| Public snip page has an audio player, summary, transcript section, and episode context | Build a fast standalone page; private-source snips publish their own recording and selected text | MVP; [public example](https://share.snipd.com/snip/059178c5-f34d-4a6e-bf62-78b227bd72fd) |
| Headphone skip controls can create snips with audible acknowledgement | Add configurable native remote-command capture; test actual headset behavior | Native phase; [headphone controls](https://support.snipd.com/en/articles/10225450-create-snips-with-your-headphones) |
| CarPlay exposes queue, recent episodes, downloads, and snipping | Preserve those information structures now so native car controls can reuse them | Later; [CarPlay](https://support.snipd.com/en/articles/10225413-how-to-use-snipd-on-apple-carplay) |
| Private RSS feeds appear with the rest of the library | Support credential-bearing RSS feeds as ordinary subscriptions with protected source access | MVP; [private feeds](https://support.snipd.com/en/articles/10226052-adding-private-rss-feeds) |
| Markdown export and Readwise sync | Keep an exportable snip format from the start; add sync adapters later | Export first; [Markdown](https://support.snipd.com/en/articles/10226246-export-your-snips-to-markdown-and-other-apps), [Readwise](https://support.snipd.com/en/articles/10226077-sync-your-snips-to-readwise) |
| Mini summaries help choose an episode | Add a short episode preview to the daily inbox | MVP; [product page](https://www.snipd.com/) |
| Episode chat, quotes, books, and guest discovery | Keep these as optional enhancements after listening and capture quality is proven | Later; [product page](https://www.snipd.com/) |

Automatic public publication of **every new snip**, including private-source recordings and transcripts, is the user's requested behavior. It is not inferred from Snipd's public documentation.

## Moving from Snipd

Snipd officially documents exporting selected highlights to Markdown from **You → Settings → Export & sync**. It separately documents RSS and OPML import into Snipd. These establish highlight export and inbound subscription import; they do not establish outbound OPML export or a supported account-sync API. [Highlight export](https://support.snipd.com/en/articles/10226246-export-your-snips-to-markdown-and-other-apps), [RSS/OPML import](https://support.snipd.com/en/articles/10226052-adding-private-rss-feeds).

**Unverified:** a supported way to continuously mirror Snipd subscriptions, export complete listening progress, retrieve full AI transcripts/chapters, or recover the exact audio version behind each existing snip. The reviewed official documentation did not resolve these. Do not make the MVP depend on undocumented Snipd endpoints.

Plan two independent import paths:

1. **Subscriptions:** accept OPML if the installed app/account can supply it; otherwise accept a list of public shows or RSS URLs and add private RSS links from their original publishers. Match public shows conservatively and let the owner resolve ambiguities. Never send private URLs to a public directory for lookup. The new app becomes the subscription source of truth after migration.
2. **Old highlights:** inspect a small Markdown export, then import its actual fields into a legacy collection. Preserve original links and text. Only attach playable local audio when episode identity, timestamps, and audio version can be verified. Do not claim that an exported link is itself an exported recording.

Importing a historical archive is distinct from tapping Snip in the new app; it should not silently mass-publish historical private data. If historical snips should also be republished, that can be an explicit migration batch. New snips publish automatically as specified.

## Transcription candidates

Word timestamps and reliable boundary alignment matter more here than a plain transcript alone. Speaker separation improves reading but is not the same as identifying speakers by real name.

The updated [Codex routine decision](codex-routines.md) uses local speech-to-text plus subscription-backed transcript analysis as the preferred path. The hosted candidates below remain alternatives; their API charges are not included merely because Codex launches the request.

| Candidate | Relevant capability | Listed base cost | Decision |
| --- | --- | --- | --- |
| Deepgram Nova-3, prerecorded monolingual | Word timing and utterances; prerecorded diarization included | $0.0043/min = $0.258/hour | Hosted fallback candidate if the local benchmark fails. [Timing](https://developers.deepgram.com/docs/utterances), [pricing](https://deepgram.com/pricing) |
| AssemblyAI Universal-3.5 Pro, prerecorded | Word timestamps; optional speaker labels | $0.21/hour + $0.02/hour diarization = $0.23/hour | Hosted comparison candidate. Confirm model identifier and language fit during implementation. [API](https://www.assemblyai.com/docs/pre-recorded-audio/api-reference/transcripts/submit), [pricing](https://www.assemblyai.com/pricing/) |
| OpenAI Whisper API, `whisper-1` | Word/segment timestamps; no built-in speaker labeling in this selection | $0.006/min = $0.36/hour | Timestamp-capable fallback candidate. [Guide](https://developers.openai.com/api/docs/guides/speech-to-text), [price](https://developers.openai.com/api/docs/models/whisper-1) |
| Local faster-whisper | CPU INT8 support and word timestamps; additional work for diarization | No per-minute API bill; server compute/operations remain | Fallback adapter, selectable per feed for audio that should stay on the host. [Repository](https://github.com/SYSTRAN/faster-whisper) |
| ElevenLabs Scribe v2 | Word timestamps, diarization up to 32 speakers, audio event tags, keyterm prompting; 3 GB / 10 h per request | $0.22/hour listed API rate on paid plans (some trackers list $0.40/hour) | **Chosen primary transcriber on October 21, 2026**; see [core/04-transcription.md](core/04-transcription.md). [Docs](https://elevenlabs.io/docs/capabilities/speech-to-text) |

The current OpenAI guide recommends `gpt-transcribe` for general file transcription but directs timestamp use cases to `whisper-1`. Its diarization model supplies speaker-labeled segments and has different parameter support. Do not assume the plain-transcription model is a drop-in replacement for word-aligned playback. OpenAI file uploads are limited to 25 MB, so a long-episode adapter needs chunking and offset reconciliation. [Official file transcription guide](https://developers.openai.com/api/docs/guides/speech-to-text).

Provider prices are a snapshot, not a quote or measured quality ranking. Deepgram's listed prerecorded multilingual rate is $0.0052/min ($0.312/hour); choose the language mode based on real feeds. Provider add-ons, retries, taxes, and text-generation processing are separate. [Deepgram pricing](https://deepgram.com/pricing).

Reuse publisher transcripts and chapter metadata when valid for the stored recording. Podcasting 2.0 defines links to both. A text-only transcript can help reading, but accurate snipping still needs alignment to the actual audio. [Podcast namespace specification](https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/1.0.md).

## Build or extend

| Approach | Advantage | Tradeoff / recommendation |
| --- | --- | --- |
| Keep Snipd plus exports | Smallest migration effort; familiar player | Does not by itself deliver the requested server-owned app and interchangeable processing pipeline |
| Audiobookshelf plus a custom snipping layer | Existing self-hosted podcast/media foundation; its API describes scheduled podcast downloads | Worth a bounded evaluation, especially because this workspace contains an Audiobookshelf/Alexa integration. The snip editor, public clip publication, and AI workflows would still need to be built. Do not assume an Audiobookshelf instance is running here. [Project](https://audiobookshelf.org/), [API](https://api.audiobookshelf.org/) |
| Focused custom player and API | Direct control over capture, publication, transcript alignment, and native-client contract | Recommended for this brief; own the player and ingestion reliability work |

The API reference for Audiobookshelf identifies itself as incomplete/outdated, so any reuse decision should validate the deployed version and source before depending on specific endpoints.

## Browser and native boundary

Web Media Session supports metadata and system media actions, but availability differs by browser. Feature-detect it and test the intended iPhone. Browser storage can be evicted and should not be the sole copy of recordings or highlights. These facts support a web-first product test, not a promise of full native offline/headphone parity. [Media Session](https://developer.mozilla.org/en-US/docs/Web/API/Media_Session_API), [WebKit storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/).

For the native companion, Apple's playback audio session and remote command APIs provide the intended foundation for background listening and accessory controls; universal links connect public pages to installed apps. The specific snipping gesture still needs device testing. [Background media behavior](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/MediaPlaybackGuide/Contents/Resources/en.lproj/RefiningTheUserExperience/RefiningTheUserExperience.html), [remote commands](https://developer.apple.com/documentation/mediaplayer/mpremotecommandcenter?language=objc), [associated domains](https://developer.apple.com/documentation/Xcode/supporting-associated-domains?changes=_2).
