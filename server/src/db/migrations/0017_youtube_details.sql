-- Opening a YouTube video shows its details at once (docs/video-plan.md, "Details first"). The server cannot reach
-- YouTube, so the home fetcher fills these in, and walks a channel's older videos when the owner asks for more.
ALTER TABLE episode ADD COLUMN metadata_at INTEGER;                       -- when the fetcher last sent this video's details; NULL: still wanted
-- Captions that failed for a passing reason (a 429). The video is kept, and nothing is transcribed (that bills); the
-- fetcher tries the captions again at captions_retry_at until they arrive or the tries run out.
ALTER TABLE episode ADD COLUMN captions_retry_at INTEGER;
ALTER TABLE episode ADD COLUMN captions_tries INTEGER NOT NULL DEFAULT 0;

-- A channel's older videos, fifteen at a time, on the owner's request.
ALTER TABLE feed ADD COLUMN listing_wanted INTEGER NOT NULL DEFAULT 0;    -- new videos still wanted from the fetcher
ALTER TABLE feed ADD COLUMN listing_offset INTEGER NOT NULL DEFAULT 0;    -- how far down the channel's videos it has walked
ALTER TABLE feed ADD COLUMN listing_ended INTEGER NOT NULL DEFAULT 0;     -- it reached the channel's first video
ALTER TABLE feed ADD COLUMN listing_error TEXT;
