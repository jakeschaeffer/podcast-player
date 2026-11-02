-- Video (docs/video-plan.md). A video is a recording with a picture: the audio_asset keeps the video file beside
-- the audio pulled out of it, on one timeline, so everything built on the audio (transcripts, snips, ad breaks,
-- heard tracking) works unchanged. The video is fetched only when wanted and may be dropped later to free disk;
-- the audio stays.
ALTER TABLE audio_asset ADD COLUMN video_path TEXT;      -- content-addressed, like path; NULL when there is no video file
ALTER TABLE audio_asset ADD COLUMN video_sha256 TEXT;
ALTER TABLE audio_asset ADD COLUMN video_bytes INTEGER;
ALTER TABLE audio_asset ADD COLUMN video_width INTEGER;
ALTER TABLE audio_asset ADD COLUMN video_height INTEGER;
ALTER TABLE audio_asset ADD COLUMN video_last_played_at INTEGER;  -- for dropping old video files, oldest first

-- A YouTube channel is a feed of kind 'youtube' (its public Atom feed is the url). Its episodes are videos.
-- A podcast episode whose show notes link one YouTube video remembers it, for "Watch video".
ALTER TABLE episode ADD COLUMN media_kind TEXT NOT NULL DEFAULT 'audio';  -- 'audio' | 'video': what the enclosure (or the YouTube video) is
ALTER TABLE episode ADD COLUMN youtube_id TEXT;                           -- the YouTube video: the episode itself (a channel's video) or the one its notes link
ALTER TABLE episode ADD COLUMN video_url_enc BLOB;                        -- a feed's own video enclosure, when the episode also has an audio one (fetched by the server)
-- The owner asked for the video (Watch video, opening a channel's video, a download). A YouTube video is fetched by
-- the home fetcher, which polls for these; a feed's own video file by the server. Cleared when the video arrives.
ALTER TABLE episode ADD COLUMN video_requested_at INTEGER;
ALTER TABLE episode ADD COLUMN video_error TEXT;                          -- why the last fetch failed, for the apps
CREATE INDEX episode_youtube ON episode(youtube_id) WHERE youtube_id IS NOT NULL;
CREATE INDEX episode_video_wanted ON episode(video_requested_at) WHERE video_requested_at IS NOT NULL;
