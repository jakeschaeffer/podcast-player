-- Topic searches (services/topicSearch.ts): one row per search the owner started, an Exa Agent run with Particle's
-- podcast transcripts. `episodes` is JSON [FoundEpisode] (adapters/exa.ts) once the run completes; `shows` is JSON
-- { podcast name: ShowResult | null }, the directory lookup for shows that are not in the database.
CREATE TABLE topic_search (
  id                TEXT PRIMARY KEY,
  query             TEXT NOT NULL,
  query_key         TEXT NOT NULL,
  client_request_id TEXT UNIQUE,
  run_id            TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  episodes          TEXT,
  shows             TEXT,
  error             TEXT,
  cost_dollars      REAL,
  checked_at        INTEGER,
  created_at        INTEGER NOT NULL,
  completed_at      INTEGER
);
CREATE INDEX topic_search_by_key ON topic_search (query_key, created_at);
CREATE INDEX topic_search_by_time ON topic_search (created_at);
