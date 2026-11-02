-- A feed can carry a show's text (articles) instead of audio; its items become episode_text rows for a companion podcast feed.
ALTER TABLE feed ADD COLUMN kind TEXT NOT NULL DEFAULT 'podcast';      -- 'podcast' | 'text'
ALTER TABLE feed ADD COLUMN text_for_feed_id TEXT REFERENCES feed(id);  -- for kind = 'text': the podcast feed whose episodes it describes
