-- Minimal data model, see docs/core/data-model.md. Wall-clock columns are Unix ms; other *_ms are asset-relative.

CREATE TABLE feed (
  id              TEXT PRIMARY KEY,
  url_enc         BLOB NOT NULL,
  url_hash        TEXT NOT NULL UNIQUE,
  is_private      INTEGER NOT NULL DEFAULT 0,
  title           TEXT, author TEXT, image_url TEXT, site_url TEXT, language TEXT,
  auto_process    INTEGER NOT NULL DEFAULT 1,
  transcriber     TEXT NOT NULL DEFAULT 'elevenlabs',
  keyterms        TEXT NOT NULL DEFAULT '[]',
  etag            TEXT, last_modified TEXT,
  last_refresh_at INTEGER, last_error TEXT,
  created_at      INTEGER NOT NULL
);

CREATE TABLE episode (
  id                TEXT PRIMARY KEY,
  feed_id           TEXT NOT NULL REFERENCES feed(id),
  guid              TEXT NOT NULL,
  title             TEXT NOT NULL,
  description_html  TEXT,
  published_at      INTEGER,
  first_seen_at     INTEGER NOT NULL,
  enclosure_url_enc BLOB NOT NULL,
  enclosure_type    TEXT, enclosure_bytes INTEGER,
  duration_hint_ms  INTEGER,
  image_url         TEXT,
  link              TEXT,
  current_asset_id  TEXT REFERENCES audio_asset(id),
  UNIQUE (feed_id, guid)
);
CREATE INDEX episode_feed_published ON episode(feed_id, published_at DESC);

CREATE TABLE audio_asset (
  id            TEXT PRIMARY KEY,
  episode_id    TEXT NOT NULL REFERENCES episode(id),
  sha256        TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  duration_ms   INTEGER NOT NULL,
  mime          TEXT NOT NULL,
  path          TEXT NOT NULL,             -- content-addressed; two episodes with identical bytes share one file
  transcript_id TEXT REFERENCES transcript(id),
  summary_id    TEXT REFERENCES episode_summary(id),
  pinned        INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX audio_asset_episode ON audio_asset(episode_id, created_at DESC);
CREATE INDEX audio_asset_sha ON audio_asset(sha256);

CREATE TABLE transcript (
  id             TEXT PRIMARY KEY,
  audio_asset_id TEXT NOT NULL REFERENCES audio_asset(id),
  provider       TEXT NOT NULL, model TEXT NOT NULL,
  language       TEXT,
  word_count     INTEGER NOT NULL,
  events         TEXT NOT NULL DEFAULT '[]',
  cost_cents     INTEGER,
  provider_request_id TEXT,
  created_at     INTEGER NOT NULL
);

CREATE TABLE transcript_segment (
  transcript_id TEXT NOT NULL REFERENCES transcript(id),
  idx           INTEGER NOT NULL,
  start_ms      INTEGER NOT NULL, end_ms INTEGER NOT NULL,
  speaker       TEXT,
  first_word    INTEGER NOT NULL,
  text          TEXT NOT NULL,
  words         TEXT NOT NULL,
  PRIMARY KEY (transcript_id, idx)
);
CREATE VIRTUAL TABLE transcript_fts USING fts5(text, content='transcript_segment', content_rowid='rowid');
CREATE TRIGGER transcript_segment_ai AFTER INSERT ON transcript_segment BEGIN
  INSERT INTO transcript_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER transcript_segment_ad AFTER DELETE ON transcript_segment BEGIN
  INSERT INTO transcript_fts(transcript_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;

CREATE TABLE episode_summary (
  id             TEXT PRIMARY KEY,
  transcript_id  TEXT NOT NULL REFERENCES transcript(id),
  model          TEXT NOT NULL, prompt_version TEXT NOT NULL,
  preview        TEXT NOT NULL,
  takeaways      TEXT NOT NULL,
  chapters       TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);

CREATE TABLE device (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  platform    TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER
);

CREATE TABLE playback_state (
  device_id      TEXT NOT NULL REFERENCES device(id),
  audio_asset_id TEXT NOT NULL REFERENCES audio_asset(id),
  position_ms    INTEGER NOT NULL,
  speed          REAL NOT NULL DEFAULT 1.0,
  playing        INTEGER NOT NULL DEFAULT 0,
  finished       INTEGER NOT NULL DEFAULT 0,
  seq            INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (device_id, audio_asset_id)
);
CREATE INDEX playback_state_asset ON playback_state(audio_asset_id, updated_at DESC);

CREATE TABLE snip (
  id                  TEXT PRIMARY KEY,
  audio_asset_id      TEXT NOT NULL REFERENCES audio_asset(id),
  anchor_ms           INTEGER NOT NULL,
  heard_from_ms       INTEGER NOT NULL,
  client_request_id   TEXT NOT NULL UNIQUE,
  share_token         TEXT NOT NULL UNIQUE,
  share_state         TEXT NOT NULL DEFAULT 'active',
  current_revision_id TEXT,
  note                TEXT,
  created_at          INTEGER NOT NULL, deleted_at INTEGER
);
CREATE INDEX snip_asset ON snip(audio_asset_id, created_at DESC);

CREATE TABLE snip_revision (
  id            TEXT PRIMARY KEY,
  snip_id       TEXT NOT NULL REFERENCES snip(id),
  rev           INTEGER NOT NULL,
  method        TEXT NOT NULL,
  transcript_id TEXT REFERENCES transcript(id),
  start_ms      INTEGER NOT NULL, end_ms INTEGER NOT NULL,
  start_word    INTEGER, end_word INTEGER,
  excerpt       TEXT,
  title         TEXT, summary TEXT,
  summary_model TEXT, summary_prompt_version TEXT,
  summary_status TEXT NOT NULL DEFAULT 'pending',
  clip_path     TEXT, clip_sha256 TEXT, clip_duration_ms INTEGER,
  status        TEXT NOT NULL,
  error         TEXT,
  selection     TEXT,
  created_at    INTEGER NOT NULL,
  UNIQUE (snip_id, rev)
);

CREATE TABLE job (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  key         TEXT NOT NULL UNIQUE,
  payload     TEXT NOT NULL,
  priority    INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  run_after   INTEGER NOT NULL, locked_until INTEGER,
  last_error  TEXT,
  created_at  INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX job_claim ON job(status, run_after, priority DESC, created_at);

CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
