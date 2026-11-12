-- Each snip as a highlight in the owner's Readwise (services/readwiseSync.ts): the highlight Readwise gave it, the
-- revision last sent, when, and when Readwise said the highlight was gone (deleted there), after which it is left alone.
ALTER TABLE snip ADD COLUMN readwise_highlight_id INTEGER;
ALTER TABLE snip ADD COLUMN readwise_revision_id TEXT;
ALTER TABLE snip ADD COLUMN readwise_synced_at INTEGER;
ALTER TABLE snip ADD COLUMN readwise_gone_at INTEGER;
