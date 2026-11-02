-- Who a transcript's voices are (core/speakers/identify.ts): JSON {"speakers": [{"label", "role", "name"}], "model",
-- "prompt_version"}, role host, guest or other, name null unless the publisher gives it. NULL until identified.
ALTER TABLE transcript ADD COLUMN speakers TEXT;
