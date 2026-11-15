-- Who wrote a revision's summary (its bullets, one per line): 'model' (the summary job) or 'owner'; null while there is none.
-- generated_summary keeps the model's bullets under the owner's own, so clearing the owner's brings them back, as
-- generated_title does for titles. Every summary before this was the model's.
ALTER TABLE snip_revision ADD COLUMN summary_source TEXT;
ALTER TABLE snip_revision ADD COLUMN generated_summary TEXT;
UPDATE snip_revision SET summary_source = 'model', generated_summary = summary WHERE summary IS NOT NULL;
