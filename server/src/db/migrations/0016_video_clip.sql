-- A snip cut from a video also gets a short MP4 for its public page (services/snipJobs.ts). The MP3 stays the clip of
-- record: a revision is ready without this, and the page plays the audio until the picture exists, or if it never does.
ALTER TABLE snip_revision ADD COLUMN video_clip_path TEXT;
ALTER TABLE snip_revision ADD COLUMN video_clip_sha256 TEXT;
ALTER TABLE snip_revision ADD COLUMN video_clip_width INTEGER;
ALTER TABLE snip_revision ADD COLUMN video_clip_height INTEGER;
