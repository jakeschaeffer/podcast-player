-- A video's details could not be read yet for a passing reason: a live stream that has not started or not ended (no
-- length, no chapters until then), or any other failure that is not final. The fetcher says so, and the video is not
-- wanted again until metadata_retry_at, rather than asked for on every pass (or skipped by the fetcher until it
-- restarts, as before, which left it waiting for good).
ALTER TABLE episode ADD COLUMN metadata_retry_at INTEGER;
