-- Edits the owner made to a tap on the device before it reached the server (offline): a span and a title, as JSON,
-- kept until the selector has chosen its own span and then applied over it as a manual revision.
ALTER TABLE snip ADD COLUMN owner_edit TEXT;
