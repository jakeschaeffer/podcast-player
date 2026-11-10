import { Type, type TSchema } from "@sinclair/typebox";

export const Nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()]);
const Id = Type.String({ minLength: 26, maxLength: 26, description: "ULID" });
const Ms = Type.Integer({ minimum: 0, description: "milliseconds" });

export const ErrorSchema = Type.Object({
  error: Type.Object({ code: Type.String(), message: Type.String(), feed_id: Type.Optional(Type.String({ description: "On a 409 from POST /v1/feeds: the feed that already has this URL" })) }),
});

export const DeviceSchema = Type.Object({ id: Id, name: Type.String(), platform: Type.String(), created_at: Type.Integer(), last_seen_at: Nullable(Type.Integer()), revoked_at: Nullable(Type.Integer()) });
export const CreateDeviceBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 80 }),
  platform: Type.Union([Type.Literal("web"), Type.Literal("ios"), Type.Literal("cli")]),
  password: Type.String({ minLength: 1 }),
  set_cookie: Type.Optional(Type.Boolean({ description: "Also set an HttpOnly cookie carrying the token, for the web app" })),
});
export const CreateDeviceResponse = Type.Object({ device: DeviceSchema, token: Type.String({ description: "Bearer token; shown once" }) });

export const FeedSchema = Type.Object({
  id: Id, kind: Type.Union([Type.Literal("podcast"), Type.Literal("text"), Type.Literal("youtube"), Type.Literal("links")], { description: "'youtube': a channel, whose episodes are videos; 'links': the Pasted links show, one-off files the owner pasted (POST /v1/links/episodes), followed and never refreshed" }), text_for_feed_id: Nullable(Id), title: Nullable(Type.String()), author: Nullable(Type.String()), image_url: Nullable(Type.String()), site_url: Nullable(Type.String()), language: Nullable(Type.String()),
  is_private: Type.Boolean(), auto_process: Type.Boolean(), transcriber: Type.String(), keyterms: Type.Array(Type.String()), backfill: Type.Integer(),
  last_refresh_at: Nullable(Type.Integer()), last_error: Nullable(Type.String()), episode_count: Type.Integer(), created_at: Type.Integer(),
  followed: Type.Boolean({ description: "In the library. An unfollowed show (opened from search) is manual, out of Today's new episodes, and not refreshed on a schedule" }),
  more_videos: Type.Object({ status: Type.Union([Type.Literal("idle"), Type.Literal("requested"), Type.Literal("failed"), Type.Literal("ended")]), error: Nullable(Type.String()) }, { description: "A YouTube channel's older videos (POST /v1/feeds/{id}/more-videos). idle: more can be asked for; requested: the home fetcher is on it; failed: see error; ended: it reached the channel's first video" }),
});
export const AddFeedBody = Type.Object({
  url: Type.String({ description: "Feed URL. Private feeds carry their credential in the URL; it is encrypted at rest and never returned." }),
  kind: Type.Optional(Type.Union([Type.Literal("podcast"), Type.Literal("text"), Type.Literal("youtube")], { description: "'text' for an articles feed whose items are the episodes' text; attach it with text_for_feed_id. A YouTube channel URL (/@handle or /channel/UC…) is recognised on its own and needs no kind" })),
  text_for_feed_id: Type.Optional(Id),
  is_private: Type.Optional(Type.Boolean()),
  auto_process: Type.Optional(Type.Boolean({ description: "Fetch, transcribe, and summarize new episodes automatically (default true)" })),
  keyterms: Type.Optional(Type.Array(Type.String({ maxLength: 50 }), { maxItems: 100 })),
  backfill: Type.Optional(Type.Integer({ minimum: 0, maximum: 500, description: "How many of the newest episodes to process on first import (default 2)" })),
  followed: Type.Optional(Type.Boolean({ description: "Add it to the library (default true). false opens a show without subscribing: always manual, no backfill" })),
});
export const UpdateFeedBody = Type.Partial(Type.Object({
  title: Type.String({ minLength: 1 }), is_private: Type.Boolean(), auto_process: Type.Boolean(),
  transcriber: Type.Union([Type.Literal("elevenlabs"), Type.Literal("whisper-local")]), keyterms: Type.Array(Type.String({ maxLength: 50 }), { maxItems: 100 }), backfill: Type.Integer({ minimum: 0, maximum: 500 }),
  followed: Type.Boolean({ description: "true follows; false unfollows (and makes the show manual) but keeps its episodes" }),
}));
export const RefreshRunSchema = Type.Object({
  run_id: Type.String(), status: Type.Union([Type.Literal("queued"), Type.Literal("running"), Type.Literal("done"), Type.Literal("failed")]), feeds: Type.Integer(),
  jobs: Type.Array(Type.Object({ feed_id: Id, status: Type.String(), last_error: Nullable(Type.String()) })), created_at: Type.Integer(),
});

const Processing = Type.Union([Type.Literal("none"), Type.Literal("queued"), Type.Literal("running"), Type.Literal("deferred"), Type.Literal("failed"), Type.Literal("ready")]);
export const ResumeSchema = Type.Object({ position_ms: Ms, speed: Type.Number(), finished: Type.Boolean(), device_name: Type.String(), updated_at: Type.Integer({ description: "When the position was observed: the reporting device's observed_at, else when the server received it" }) });
export const EpisodeListItemSchema = Type.Object({
  id: Id, feed_id: Id, show_title: Nullable(Type.String()), title: Type.String(), published_at: Nullable(Type.Integer()), duration_ms: Nullable(Type.Integer()), image_url: Nullable(Type.String()),
  asset_id: Nullable(Id), transcript_id: Nullable(Id), has_summary: Type.Boolean(),
  processing: Type.Object({ audio: Processing, transcript: Processing, text: Processing, summary: Processing }),
  resume: Nullable(ResumeSchema),
  media_kind: Type.Union([Type.Literal("audio"), Type.Literal("video")], { description: "'video' when the episode is a video (a channel's, or a feed's video enclosure)" }),
  youtube_id: Nullable(Type.String({ description: "The YouTube video the episode is, or the one its show notes link" })),
  video: Type.Object({
    status: Type.Union([Type.Literal("none"), Type.Literal("available"), Type.Literal("requested"), Type.Literal("ready"), Type.Literal("failed")], { description: "none: no video exists; available: one can be fetched (POST /v1/episodes/{id}/video); requested: on its way; ready: the recording has a video file; failed: see error" }),
    error: Nullable(Type.String()),
  }),
});
export const WantedListingSchema = Type.Object({ feed_id: Id, channel_id: Type.String(), offset: Type.Integer(), count: Type.Integer() });
export const WantedDetailsSchema = Type.Object({ episode_id: Id, youtube_id: Type.String(), title: Type.String() });
export const WantedVideoSchema = Type.Object({ episode_id: Id, youtube_id: Type.String(), title: Type.String(), show_title: Nullable(Type.String()), requested_at: Type.Integer() });
export const ChapterSchema = Type.Object({ start_ms: Ms, end_ms: Ms, start_word: Type.Integer(), end_word: Type.Integer(), title: Type.String(), description: Type.String(), kind: Type.String() });
export const EpisodeDetailSchema = Type.Composite([
  EpisodeListItemSchema,
  Type.Object({
    description_html: Nullable(Type.String()), link: Nullable(Type.String()),
    text: Nullable(Type.Object({ id: Id, source: Type.String(), kind: Nullable(Type.String()), word_count: Type.Integer(), sections: Type.Array(Type.Object({ title: Type.String(), start_ms: Nullable(Type.Integer()), start_word: Nullable(Type.Integer()) })), aligned_transcript_id: Nullable(Id) })),
    chapters: Nullable(Type.Object({
      source: Type.Union([Type.Literal("publisher"), Type.Literal("feed"), Type.Literal("shownotes"), Type.Literal("ai")], { description: "Whose chapters: aligned publisher text, the feed's chapters, show-notes timestamps, or the summary model (in that order of preference)" }),
      transcript_id: Nullable(Id),
      items: Type.Array(Type.Object({ start_ms: Ms, end_ms: Ms, start_word: Nullable(Type.Integer()), end_word: Nullable(Type.Integer()), title: Type.String(), description: Nullable(Type.String()), kind: Type.String() })),
    })),
    asset: Nullable(Type.Object({
      id: Id, duration_ms: Ms, mime: Type.String(), bytes: Type.Integer(), audio_url: Type.String({ description: "Signed, expiring; supports Range" }),
      video_url: Nullable(Type.String({ description: "The recording's video file (MP4) on the same timeline, signed and expiring; null for audio" })),
      video_width: Nullable(Type.Integer()), video_height: Nullable(Type.Integer()), video_bytes: Nullable(Type.Integer()),
    })),
    summary: Nullable(Type.Object({ id: Id, preview: Type.String(), takeaways: Type.Array(Type.Object({ text: Type.String(), word: Type.Integer() })), chapters: Type.Array(Type.Unknown()), model: Type.String(), prompt_version: Type.String() })),
    snip_count: Type.Integer(),
    ad_breaks: Type.Array(Type.Object({
      start_ms: Ms,
      end_ms: Ms,
      confidence: Type.Union([Type.Literal("high"), Type.Literal("medium")], { description: "high when two signals agree, medium when one does" }),
      sources: Type.Array(Type.Union([Type.Literal("publisher_gap"), Type.Literal("sponsor_phrase"), Type.Literal("ad_chapter")])),
      cue: Nullable(Type.String({ description: "The sponsor phrase heard in the break, normalized" })),
    }), { description: "Suspected ad breaks on `asset`, oldest first; offer a skip to end_ms while one plays. Never skipped automatically" }),
  }),
]);
export const PageQuery = Type.Object({ after: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) });

const WordTuple = Type.Tuple([Ms, Ms, Type.String()]);
export const SpeakerSchema = Type.Object({
  label: Type.String({ description: "The transcript's label: S1, S2… by order of first appearance" }),
  role: Type.Union([Type.Literal("host"), Type.Literal("guest"), Type.Literal("other")], { description: "The show's host, a guest the host is talking with, or anyone else (a clip, an ad, a quote read aloud)" }),
  name: Nullable(Type.String({ description: "Only when the show's author, titles or show notes say who it is" })),
});
export const SpeakersSchema = Type.Object({
  speakers: Nullable(Type.Array(SpeakerSchema, { description: "Null until worked out (asking queues it), or when the transcript has no speaker labels" })),
});
export const TranscriptSchema = Type.Object({
  id: Type.Optional(Id), asset_id: Type.Optional(Id), language: Nullable(Type.String()), word_count: Type.Integer(),
  segments: Type.Array(Type.Object({ s: Ms, e: Ms, spk: Nullable(Type.String()), w0: Type.Integer(), words: Type.Array(WordTuple) })),
  events: Type.Array(Type.Tuple([Ms, Ms, Type.String()])),
});

export const PlaybackBody = Type.Object({
  position_ms: Ms, speed: Type.Number({ minimum: 0.25, maximum: 4 }), playing: Type.Boolean(), finished: Type.Boolean(), seq: Type.Integer({ minimum: 0 }),
  observed_at: Type.Optional(Type.Integer({ minimum: 0, description: "Unix ms on the device's clock when this position was observed; orders replays from an offline queue. Capped at receipt time" })),
});
export const PlaybackResponse = Type.Object({ accepted: Type.Boolean(), position_ms: Ms, speed: Type.Number(), playing: Type.Boolean(), finished: Type.Boolean(), seq: Type.Integer(), updated_at: Type.Integer() });

export const RevisionSchema = Type.Object({
  id: Id, rev: Type.Integer(), method: Type.String(), status: Type.String(),
  transcript_id: Nullable(Type.String({ description: "The transcript start_word and end_word index into" })),
  start_ms: Ms, end_ms: Ms, start_word: Nullable(Type.Integer()), end_word: Nullable(Type.Integer()),
  excerpt: Nullable(Type.String()), title: Nullable(Type.String()), title_source: Nullable(Type.String({ description: "Who wrote the title: model, fallback, or owner" })), summary: Nullable(Type.String({ description: "Since snip-summary v3, bullets, one per line; earlier summaries are prose" })),
  quote: Nullable(Type.String({ description: "A line copied word for word from the excerpt, chosen by the summary; null when there is none" })), summary_status: Type.String(),
  clip_url: Nullable(Type.String()), clip_duration_ms: Nullable(Type.Integer()), error: Nullable(Type.String()), selection: Type.Unknown(), created_at: Type.Integer(),
});
export const SnipSchema = Type.Object({
  id: Id, asset_id: Id, episode_id: Id, episode_title: Type.String(), show_title: Nullable(Type.String()),
  image_url: Nullable(Type.String({ description: "The episode's artwork, else its show's" })),
  media_kind: Type.Union([Type.Literal("audio"), Type.Literal("video")], { description: "Which of the episode's recordings the snip was cut from: its video, or its audio. An episode's snips are one list in time order whichever recording each came from" }),
  anchor_ms: Ms, heard_from_ms: Ms, share_url: Type.String(), share_state: Type.String(), note: Nullable(Type.String()), created_at: Type.Integer(),
  captured_at: Type.Integer({ description: "When the owner tapped Snip: the device's captured_at, else created_at" }),
  revision: Nullable(RevisionSchema),
});
export const CreateSnipBody = Type.Object({
  client_request_id: Type.String({ minLength: 8, maxLength: 64, description: "Idempotency key generated on the device" }),
  asset_id: Id,
  anchor_ms: Ms,
  heard_from_ms: Ms,
  captured_at: Type.Optional(Type.Integer({ minimum: 0, description: "Unix ms on the device's clock when the owner tapped; capped at receipt time" })),
});
export const EditSnipBody = Type.Partial(Type.Object({
  start_ms: Ms, end_ms: Ms, start_word: Type.Integer({ minimum: 0 }), end_word: Type.Integer({ minimum: 1 }),
  transcript_id: Type.String({ minLength: 26, maxLength: 26, description: "Required with start_word/end_word: the transcript the indices refer to. 409 if it is no longer current" }),
  snap: Type.Boolean({ description: "Snap millisecond edits to word boundaries (default true)" }),
  note: Nullable(Type.String({ maxLength: 4000 })), title: Type.String({ minLength: 1, maxLength: 120 }),
  if_revision: Type.String({ minLength: 26, maxLength: 26, description: "The revision the edit was made against. Required when moving boundaries, so a replayed edit cannot create a second revision; 409 if the snip has moved on" }),
  regenerate_summary: Type.Boolean({ description: "With a boundary edit: write the title and summary again for the new span (true) or keep the current ones (false). Left out, they are written again only when the length changes by more than 10 s" }),
}));
export const SnipListQuery = Type.Composite([PageQuery, Type.Object({ asset_id: Type.Optional(Id), episode_id: Type.Optional(Id), q: Type.Optional(Type.String({ maxLength: 200 })) })]);

export const JobSchema = Type.Object({
  id: Id, kind: Type.String(), key: Type.String(), priority: Type.Integer(), status: Type.String(), attempts: Type.Integer(),
  run_after: Type.Integer(), last_error: Nullable(Type.String()), created_at: Type.Integer(), updated_at: Type.Integer(),
});

export const ShowResultSchema = Type.Object({
  title: Type.String(), author: Nullable(Type.String()), feed_url: Type.String(), artwork_url: Nullable(Type.String()), site_url: Nullable(Type.String()),
  episode_count: Nullable(Type.Integer()), genres: Type.Array(Type.String()), source: Type.String(),
  /** Set when this feed is already subscribed. */
  feed_id: Nullable(Id),
  followed: Nullable(Type.Boolean({ description: "Whether the feed with feed_id is in the library; null when there is no such feed" })),
});

export const PublicSnipJson = Type.Object({
  token: Type.String(), rev: Type.Integer(), title: Type.String(), summary: Nullable(Type.String()), quote: Nullable(Type.String()), excerpt: Nullable(Type.String()),
  turns: Nullable(Type.Array(Type.Object({
    speaker: Nullable(Type.String({ description: "S1, S2… by order of first appearance in the episode" })),
    name: Type.String({ description: "Shown for the speaker: their name when the publisher gives it, else Host, Guest, or Speaker 2" }),
    text: Type.String(),
  }), { description: "The excerpt split by speaker, when more than one person speaks in it" })), duration_ms: Ms, clip_url: Type.String(), created_at: Type.Integer(),
  episode: Type.Object({ title: Type.String(), public_url: Nullable(Type.String()) }), show: Type.Object({ title: Nullable(Type.String()), site_url: Nullable(Type.String()) }),
});

export const TitleEditSchema = Type.Object({
  id: Id, snip_id: Id, revision_id: Id, episode_id: Id, feed_id: Id, episode_title: Type.String(), show_title: Nullable(Type.String()),
  previous_title: Nullable(Type.String()), previous_source: Nullable(Type.String()), new_title: Type.String(),
  generated_title: Nullable(Type.String({ description: "The model's title for this span, for comparison" })), summary_model: Nullable(Type.String()), summary_prompt_version: Nullable(Type.String()),
  start_ms: Ms, end_ms: Ms, excerpt: Nullable(Type.String()), created_at: Type.Integer(),
});

export const EpisodeShareSchema = Type.Object({
  share_url: Type.String({ description: "The public page listing every shared snip of the episode" }),
  state: Type.Union([Type.Literal("active"), Type.Literal("revoked")]),
  snip_count: Type.Integer({ description: "Snips a recipient would see right now: active and ready" }),
  created_at: Type.Integer(),
});

const ScoreSchema = Type.Object({ passed: Type.Integer(), n: Type.Integer(), rate: Type.Number({ description: "passed / n" }), margin: Type.Number({ description: "half-width of the 95% Wilson interval for rate" }) });
const EvalRefSchema = Type.Object({ id: Type.String(), label: Type.String() });
const editRate = (description: string) => Type.Object({ snips: Type.Integer({ description: "Live snips it wrote for" }), edited: Type.Integer({ description: "Of those, the ones the owner then changed" }) }, { description });
export const PromptSchema = Type.Object({
  name: Type.String(), label: Type.String(), active: Type.String({ description: "The version production uses" }),
  in_use: Type.Boolean({ description: "Whether production calls this prompt at all" }), eval: Nullable(EvalRefSchema),
  edits_label: Nullable(Type.String({ description: "What the owner's edit of this prompt's output is called (\"titles rewritten\", \"spans moved\"); null when what it writes cannot be edited" })),
  rules_edits: Nullable(editRate("Snip start only: spans the fixed rules chose, and how many the owner moved. Every snip, while the prompt is off")),
  versions: Type.Array(Type.Object({ version: Type.String(), created_at: Type.Integer(), active: Type.Boolean(), score: Nullable(ScoreSchema), edits: Nullable(editRate("What the owner changed of what this version wrote in use; null when it has written for no live snip")) }), { description: "Newest first; score is the version's latest finished run" }),
});
export const EvalRunSchema = Type.Object({
  id: Type.String(), eval: Type.String(), version: Nullable(Type.String()), run_at: Type.Integer(),
  status: Type.Union([Type.Literal("queued"), Type.Literal("running"), Type.Literal("done"), Type.Literal("failed")]),
  score: Nullable(ScoreSchema), progress: Nullable(Type.Object({ done: Type.Integer(), total: Type.Integer() })), error: Nullable(Type.String()),
});
export const PromptVersionSchema = Type.Object({
  name: Type.String(), label: Type.String(), version: Type.String(), text: Type.String(), created_at: Type.Integer(), active: Type.Boolean(),
  previous: Nullable(Type.Object({ version: Type.String(), text: Type.String() })), eval: Nullable(EvalRefSchema), runs: Type.Array(EvalRunSchema),
});
export const EvalRunDetailSchema = Type.Object({
  run: EvalRunSchema,
  cases: Type.Array(Type.Object({ id: Type.String(), pass: Type.Boolean(), score: Nullable(Type.Integer()), expected: Type.String(), actual: Type.String(), note: Nullable(Type.String()) }), { description: "Failures first" }),
});
