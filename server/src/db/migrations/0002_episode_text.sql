-- Publisher-supplied episode text (for now: email newsletters) and transcripts derived from it by forced alignment.

CREATE TABLE episode_text (
  id          TEXT PRIMARY KEY,
  episode_id  TEXT NOT NULL REFERENCES episode(id),
  source      TEXT NOT NULL,              -- 'email'
  source_ref  TEXT NOT NULL UNIQUE,       -- e.g. the Gmail message id
  title       TEXT NOT NULL,
  kind        TEXT,                       -- 'update' | 'article' | 'interview' | 'other'
  text        TEXT NOT NULL,              -- the body as sent to alignment, paragraphs separated by blank lines
  paragraphs  TEXT NOT NULL,              -- JSON [{"text","speaker","quote","section"}]
  sections    TEXT NOT NULL,              -- JSON [{"title","first_paragraph","start_word","start_ms"}]
  word_count  INTEGER NOT NULL,
  received_at INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX episode_text_episode ON episode_text(episode_id);

ALTER TABLE transcript ADD COLUMN source TEXT NOT NULL DEFAULT 'asr';   -- 'asr' | 'email'
ALTER TABLE transcript ADD COLUMN text_id TEXT REFERENCES episode_text(id);
ALTER TABLE transcript ADD COLUMN loss REAL;                            -- forced-alignment loss, lower is better
