-- Where each passage of a transcript begins (services/episodeMaps.ts), one row per transcript and prompt version.
-- `starts` is JSON: [{ word, ms, title, major, needs_start? }], word indices into that transcript.
CREATE TABLE episode_map (
  transcript_id  TEXT NOT NULL REFERENCES transcript(id),
  prompt_version TEXT NOT NULL,
  model          TEXT,
  starts         TEXT NOT NULL,
  elapsed_ms     INTEGER,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (transcript_id, prompt_version)
);
