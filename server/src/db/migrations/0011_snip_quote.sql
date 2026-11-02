-- One line of a snip's excerpt, copied word for word by the summary (snip-summary v3 and later), shown as a pull
-- quote; NULL when the model found none or the summary predates it. Since v3, `summary` holds bullets, one per line.
ALTER TABLE snip_revision ADD COLUMN quote TEXT;
