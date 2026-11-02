-- Chapters the publisher puts in the feed. `chapters_url_enc` is a Podcasting 2.0 JSON chapters URL, encrypted like
-- the enclosure URL because a private feed's links can carry its token; `feed_chapters` holds the points as JSON
-- `[{start_ms, title}]`, from Podlove Simple Chapters inline in the item or from that URL once fetched, and `[]`
-- when the URL answered with nothing usable (so it is not fetched again). Show-notes timestamps are read from
-- `description_html` when the episode is served and need no column.
ALTER TABLE episode ADD COLUMN chapters_url_enc BLOB;
ALTER TABLE episode ADD COLUMN feed_chapters TEXT;
