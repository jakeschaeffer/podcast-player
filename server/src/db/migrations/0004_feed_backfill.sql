-- backfill was kept in the setting table while the feed shape settled; it is a feed attribute.
ALTER TABLE feed ADD COLUMN backfill INTEGER NOT NULL DEFAULT 2;
UPDATE feed SET backfill = (SELECT CAST(value AS INTEGER) FROM setting WHERE key = 'feed_backfill:' || feed.id)
  WHERE EXISTS (SELECT 1 FROM setting WHERE key = 'feed_backfill:' || feed.id);
DELETE FROM setting WHERE key LIKE 'feed_backfill:%';
