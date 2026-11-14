/** Row shapes as stored. Views for the API are derived from these in the services. */

export type FeedRow = {
  id: string; url_enc: Buffer; url_hash: string; is_private: number;
  title: string | null; author: string | null; image_url: string | null; site_url: string | null; language: string | null;
  auto_process: number; transcriber: string; keyterms: string;
  etag: string | null; last_modified: string | null; last_refresh_at: number | null; last_error: string | null; created_at: number;
  /** 'youtube': a channel, whose url is its public Atom feed and whose episodes are videos (docs/video-plan.md);
   * 'links': the Pasted links show (services/links.ts), whose url is a placeholder and which is never refreshed. */
  kind: "podcast" | "text" | "youtube" | "links"; text_for_feed_id: string | null;
  /** How many of the newest episodes to process on first import. */
  backfill: number;
  /** 0 for a show opened from search without subscribing: out of the library, Today, and the scheduled refresh. */
  followed: number;
  /** A channel's older videos, listed by the home fetcher on the owner's request (services/channelVideos.ts). */
  listing_wanted: number; listing_offset: number; listing_ended: number; listing_error: string | null;
};

export type EpisodeRow = {
  id: string; feed_id: string; guid: string; title: string; description_html: string | null;
  published_at: number | null; first_seen_at: number; enclosure_url_enc: Buffer; enclosure_type: string | null; enclosure_bytes: number | null;
  duration_hint_ms: number | null; image_url: string | null; link: string | null; current_asset_id: string | null;
  /** Encrypted `<podcast:chapters>` JSON URL, and the publisher's chapter points as JSON `[{start_ms, title}]` (`[]`: none usable). */
  chapters_url_enc: Buffer | null; feed_chapters: string | null;
  /** 'video' when the episode is a video (a channel's, or a feed's video enclosure); the YouTube video it is or links. */
  media_kind: "audio" | "video"; youtube_id: string | null;
  /** A feed's own video file, when the episode has an audio enclosure too. */
  video_url_enc: Buffer | null;
  /** When the home fetcher sent the video's details; when to try its captions again, and how many tries so far. */
  metadata_at: number | null; metadata_retry_at: number | null; captions_retry_at: number | null; captions_tries: number;
};

export type AudioAssetRow = {
  id: string; episode_id: string; sha256: string; bytes: number; duration_ms: number; mime: string; path: string;
  transcript_id: string | null; summary_id: string | null; pinned: number; created_at: number;
  /** The video file on the same timeline as `path`, when the recording is a video; may be dropped to free disk. */
  video_path: string | null; video_sha256: string | null; video_bytes: number | null; video_width: number | null; video_height: number | null;
  video_last_played_at: number | null;
};

export type TranscriptRow = {
  id: string; audio_asset_id: string; provider: string; model: string; language: string | null; word_count: number;
  events: string; cost_cents: number | null; provider_request_id: string | null;
  /** 'captions': a YouTube video's own captions (core/transcript/captions.ts), as good as 'asr' for every purpose. */
  source: "asr" | "email" | "rss" | "captions"; text_id: string | null; loss: number | null; created_at: number;
  /** JSON from the speakers job (services/speakers.ts), or null until it has run. */
  speakers: string | null;
};

export type SegmentRow = { transcript_id: string; idx: number; start_ms: number; end_ms: number; speaker: string | null; first_word: number; text: string; words: string };

export type EpisodeSummaryRow = { id: string; transcript_id: string; model: string; prompt_version: string; preview: string; takeaways: string; chapters: string; created_at: number };

export type DeviceRow = { id: string; name: string; platform: string; token_hash: string; created_at: number; last_seen_at: number | null; revoked_at: number | null };

export type PlaybackStateRow = { device_id: string; audio_asset_id: string; position_ms: number; speed: number; playing: number; finished: number; seq: number; updated_at: number; observed_at: number | null };

export type SnipRow = {
  id: string; audio_asset_id: string; anchor_ms: number; heard_from_ms: number; client_request_id: string; share_token: string;
  share_state: "active" | "revoked"; current_revision_id: string | null; note: string | null; created_at: number; deleted_at: number | null; captured_at: number | null;
  /** The snip's highlight in the owner's Readwise (services/readwiseSync.ts): its id, the revision last sent, when, and when Readwise said it was deleted there. */
  readwise_highlight_id: number | null; readwise_revision_id: string | null; readwise_synced_at: number | null; readwise_gone_at: number | null;
};

export type RevisionStatus = "waiting" | "selecting" | "preparing" | "ready" | "failed";
export type SummaryStatus = "pending" | "ready" | "failed" | "skipped";

export type SnipRevisionRow = {
  id: string; snip_id: string; rev: number; method: "map" | "model" | "snap" | "heuristic" | "fixed" | "manual"; transcript_id: string | null;
  start_ms: number; end_ms: number; start_word: number | null; end_word: number | null; excerpt: string | null;
  title: string | null; summary: string | null; quote: string | null; summary_model: string | null; summary_prompt_version: string | null; summary_status: SummaryStatus;
  /** Who wrote `title`: the summary model, the excerpt-based fallback, or the owner. */
  title_source: "model" | "fallback" | "owner" | null; generated_title: string | null;
  clip_path: string | null; clip_sha256: string | null; clip_duration_ms: number | null;
  /** The MP4 for the public page, when the snip was cut from a video; its poster sits beside it as `.jpg`. */
  video_clip_path: string | null; video_clip_sha256: string | null; video_clip_width: number | null; video_clip_height: number | null;
  status: RevisionStatus; error: string | null; selection: string | null; created_at: number;
};
