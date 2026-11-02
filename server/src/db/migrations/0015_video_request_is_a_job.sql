-- Asking for an episode's video is a fetch_video job like any other fetch (services/video.ts): queued, running, parked
-- while the home fetcher brings it, done, or failed with its message. The two columns 0014 added for that are gone.
DROP INDEX IF EXISTS episode_video_wanted;
ALTER TABLE episode DROP COLUMN video_requested_at;
ALTER TABLE episode DROP COLUMN video_error;
