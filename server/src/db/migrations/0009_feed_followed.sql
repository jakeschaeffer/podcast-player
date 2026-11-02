-- A show opened from search without subscribing: its episodes are real rows (playable, processable, snippable) but
-- it stays out of the library, Today's new episodes, and the scheduled refresh. Existing feeds are followed.
ALTER TABLE feed ADD COLUMN followed INTEGER NOT NULL DEFAULT 1;
