# Minimal data model

Eleven tables, one SQLite file, two media directories. This is the smallest model that supports the six core functions, an iOS client, and reproducible evals. Anything not listed here (OPML imports, episode share pages, tags, Readwise sync, multiple owners) is added later by migration and must not be anticipated with speculative columns now.

## Entity map

```text
feed ──< episode ──< audio_asset ──< transcript ──< transcript_segment
                         │  │            │
                         │  │            └──< episode_summary
                         │  └──< playback_state >── device
                         └──< snip ──< snip_revision
job   setting
```

Arrows read "one to many". `audio_asset` is the hub: every timestamp in the system is relative to exactly one asset.

## Schema

IDs are ULIDs stored as 26-character text (sortable, URL-safe, generated client-side when needed for offline captures). `created_at` and other wall-clock columns are Unix milliseconds. Every `*_ms` column that is not wall clock is milliseconds from the start of the asset it belongs to.

```sql
CREATE TABLE feed (
  id            TEXT PRIMARY KEY,
  url_enc       BLOB NOT NULL,            -- feed URL encrypted at rest; private feeds carry credentials in the URL
  is_private    INTEGER NOT NULL DEFAULT 0,
  title         TEXT, author TEXT, image_url TEXT, site_url TEXT, language TEXT,
  kind          TEXT NOT NULL DEFAULT 'podcast', -- 'podcast' (episodes with audio) or 'text' (the show's articles, attached to a podcast feed)
  text_for_feed_id TEXT REFERENCES feed(id),     -- for text feeds: the podcast feed whose episodes the items describe
  auto_process  INTEGER NOT NULL DEFAULT 1, -- new episodes are fetched, transcribed, and summarized without being played; off = manual mode
  backfill      INTEGER NOT NULL DEFAULT 2, -- how many of the newest episodes to process on first import
  followed      INTEGER NOT NULL DEFAULT 1, -- 0: opened from search, not in the library; always manual, not refreshed on a schedule, out of Today unless in progress
  transcriber   TEXT NOT NULL DEFAULT 'elevenlabs', -- or 'whisper-local' for audio that must stay on the host
  keyterms      TEXT NOT NULL DEFAULT '[]', -- JSON string[] of show-specific names passed to the transcriber
  etag          TEXT, last_modified TEXT,  -- conditional GET validators
  last_refresh_at INTEGER, last_error TEXT,
  created_at    INTEGER NOT NULL
);

CREATE TABLE episode (
  id                TEXT PRIMARY KEY,
  feed_id           TEXT NOT NULL REFERENCES feed(id),
  guid              TEXT NOT NULL,
  title             TEXT NOT NULL,
  description_html  TEXT,                 -- sanitized show notes; owner-only, never copied to public pages
  published_at      INTEGER,
  first_seen_at     INTEGER NOT NULL,
  enclosure_url_enc BLOB NOT NULL,        -- encrypted like the feed URL; private enclosures carry tokens too
  enclosure_type    TEXT, enclosure_bytes INTEGER,
  duration_hint_ms  INTEGER,              -- from the feed; display only, never used for math
  image_url         TEXT,
  current_asset_id  TEXT REFERENCES audio_asset(id),
  UNIQUE (feed_id, guid)
);

CREATE TABLE audio_asset (
  id            TEXT PRIMARY KEY,
  episode_id    TEXT NOT NULL REFERENCES episode(id),
  sha256        TEXT NOT NULL,            -- not unique: two episodes with identical bytes share one file but keep separate rows
  bytes         INTEGER NOT NULL,
  duration_ms   INTEGER NOT NULL,         -- measured with ffprobe after download, never taken from the feed
  mime          TEXT NOT NULL,
  path          TEXT NOT NULL,            -- media/assets/<sha256>.<ext>, content-addressed
  transcript_id TEXT REFERENCES transcript(id),      -- current transcript, if any
  summary_id    TEXT REFERENCES episode_summary(id), -- current episode summary, if any
  pinned        INTEGER NOT NULL DEFAULT 0, -- set when the first snip references it; pinned assets are never evicted
  created_at    INTEGER NOT NULL
);

CREATE TABLE transcript (
  id             TEXT PRIMARY KEY,
  audio_asset_id TEXT NOT NULL REFERENCES audio_asset(id),
  provider       TEXT NOT NULL, model TEXT NOT NULL,  -- e.g. 'elevenlabs', 'scribe_v2'
  language       TEXT,
  word_count     INTEGER NOT NULL,
  events         TEXT NOT NULL DEFAULT '[]', -- JSON [[start_ms,end_ms,"music"],...] non-speech audio events
  cost_cents     INTEGER,
  source         TEXT NOT NULL DEFAULT 'asr', -- 'asr' | 'rss' | 'email': where the words came from
  text_id        TEXT REFERENCES episode_text(id), -- set when the words are publisher text timed by forced alignment
  loss           REAL,                       -- forced-alignment loss; lower is better
  created_at     INTEGER NOT NULL
);
-- An asset may hold several transcripts (one per source); `audio_asset.transcript_id` names the current one.

CREATE TABLE transcript_segment (
  transcript_id TEXT NOT NULL REFERENCES transcript(id),
  idx           INTEGER NOT NULL,
  start_ms      INTEGER NOT NULL, end_ms INTEGER NOT NULL,
  speaker       TEXT,                     -- provider label such as 'S1'; never a guessed real name
  first_word    INTEGER NOT NULL,         -- global index of this segment's first word
  text          TEXT NOT NULL,            -- words joined with spaces; indexed by FTS5 for search
  words         TEXT NOT NULL,            -- JSON [[start_ms,end_ms,"text"],...]; word i of the segment is global index first_word + i
  PRIMARY KEY (transcript_id, idx)
);
CREATE VIRTUAL TABLE transcript_fts USING fts5(text, content='transcript_segment');

CREATE TABLE episode_text (             -- publisher-supplied text for an episode (added with the email source)
  id          TEXT PRIMARY KEY,
  episode_id  TEXT NOT NULL REFERENCES episode(id),
  source      TEXT NOT NULL,            -- 'rss' (a text feed item) or 'email'
  source_ref  TEXT NOT NULL UNIQUE,     -- the item guid or mail message id
  title       TEXT NOT NULL, kind TEXT, -- 'update' | 'article' | 'interview' | 'other'
  text        TEXT NOT NULL,            -- the body as sent to forced alignment
  paragraphs  TEXT NOT NULL,            -- JSON [{"text","speaker","quote","section"}]
  sections    TEXT NOT NULL,            -- JSON [{"title","first_paragraph","start_word","start_ms"}]: publisher chapters once aligned
  word_count  INTEGER NOT NULL, received_at INTEGER, created_at INTEGER NOT NULL
);

CREATE TABLE episode_summary (
  id             TEXT PRIMARY KEY,
  transcript_id  TEXT NOT NULL REFERENCES transcript(id),
  model          TEXT NOT NULL, prompt_version TEXT NOT NULL,
  preview        TEXT NOT NULL,           -- two or three sentences for lists
  takeaways      TEXT NOT NULL,           -- JSON [{"text":..., "word":<supporting global word index>}]
  chapters       TEXT NOT NULL,           -- JSON [{"start_ms","end_ms","start_word","end_word","title","description","kind"}]
  created_at     INTEGER NOT NULL
);

CREATE TABLE device (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  platform    TEXT NOT NULL,              -- 'web' | 'ios'
  token_hash  TEXT NOT NULL UNIQUE,       -- bearer token, hashed
  created_at  INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER
);

CREATE TABLE playback_state (
  device_id      TEXT NOT NULL REFERENCES device(id),
  audio_asset_id TEXT NOT NULL REFERENCES audio_asset(id),
  position_ms    INTEGER NOT NULL,
  speed          REAL NOT NULL DEFAULT 1.0,
  playing        INTEGER NOT NULL DEFAULT 0,
  finished       INTEGER NOT NULL DEFAULT 0,
  seq            INTEGER NOT NULL,        -- client-monotonic per device; a lower seq than stored is ignored
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (device_id, audio_asset_id)
);

CREATE TABLE snip (
  id                  TEXT PRIMARY KEY,
  audio_asset_id      TEXT NOT NULL REFERENCES audio_asset(id),
  anchor_ms           INTEGER NOT NULL,   -- player position at the tap
  heard_from_ms       INTEGER NOT NULL,   -- start of the unbroken listening run containing the anchor
  client_request_id   TEXT NOT NULL UNIQUE, -- idempotency key from the device's outbox
  share_token         TEXT NOT NULL UNIQUE, -- 100-bit random, base32; allocated at creation
  share_state         TEXT NOT NULL DEFAULT 'active', -- 'active' | 'revoked'
  current_revision_id TEXT,               -- the only revision a public URL can ever resolve to
  note                TEXT,               -- owner's own words; never generated, never published automatically
  created_at          INTEGER NOT NULL, deleted_at INTEGER
);

CREATE TABLE snip_revision (
  id            TEXT PRIMARY KEY,
  snip_id       TEXT NOT NULL REFERENCES snip(id),
  rev           INTEGER NOT NULL,
  method        TEXT NOT NULL,            -- 'model' | 'heuristic' | 'fixed' | 'manual'
  transcript_id TEXT REFERENCES transcript(id),
  start_ms      INTEGER NOT NULL, end_ms INTEGER NOT NULL,
  start_word    INTEGER, end_word INTEGER, -- [start_word, end_word) in transcript_id; NULL until a transcript exists
  excerpt       TEXT,                     -- exact words in range, materialized; public pages read only this column
  title         TEXT, summary TEXT,
  summary_model TEXT, summary_prompt_version TEXT,
  summary_status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'ready' | 'failed' | 'skipped'; ready requires the clip and a concluded summary step
  title_source  TEXT,                     -- 'model' | 'fallback' | 'owner'; an owner's title is never overwritten and carries over to later revisions
  generated_title TEXT,                   -- the summary model's title for this span, kept after the owner rewrites it
  clip_path     TEXT, clip_sha256 TEXT, clip_duration_ms INTEGER,
  status        TEXT NOT NULL,            -- 'waiting' | 'selecting' | 'preparing' | 'ready' | 'failed'
  error         TEXT,
  selection     TEXT,                     -- JSON: window, candidates, chosen ids, model rejection; the eval record of how the span was picked
  created_at    INTEGER NOT NULL,
  UNIQUE (snip_id, rev)
);

CREATE TABLE episode_share (            -- the public page of every shared snip in one episode, made only when the owner shares it
  id TEXT PRIMARY KEY, episode_id TEXT NOT NULL UNIQUE, share_token TEXT NOT NULL UNIQUE,
  share_state TEXT NOT NULL DEFAULT 'active', -- 'active' | 'revoked'; sharing again reactivates the same token
  created_at INTEGER NOT NULL, revoked_at INTEGER
);

CREATE TABLE title_edit (               -- every title the owner writes: ground truth for title evals
  id TEXT PRIMARY KEY, snip_id TEXT NOT NULL, revision_id TEXT NOT NULL,
  previous_title TEXT, previous_source TEXT, new_title TEXT NOT NULL,
  generated_title TEXT, summary_model TEXT, summary_prompt_version TEXT, -- the model's title for the span, filled in when the summary lands
  start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, excerpt TEXT, created_at INTEGER NOT NULL
);

CREATE TABLE job (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,              -- refresh_feed | fetch_audio | transcribe | summarize_episode | select_snip | render_clip | summarize_snip
  key         TEXT NOT NULL UNIQUE,       -- '<kind>:<subject id>'; enqueueing an existing key is a no-op
  payload     TEXT NOT NULL,              -- JSON
  priority    INTEGER NOT NULL DEFAULT 0, -- 100 snip-blocking, 50 play-triggered, 0 daily catalog
  status      TEXT NOT NULL,              -- 'queued' | 'running' | 'done' | 'failed' | 'deferred'
  attempts    INTEGER NOT NULL DEFAULT 0,
  run_after   INTEGER NOT NULL, locked_until INTEGER,
  last_error  TEXT,
  created_at  INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

## Files on disk

```text
data/
  app.db                       SQLite, WAL mode
  media/assets/<sha256>.<ext>  immutable source recordings, content-addressed
  media/clips/<revision_id>.mp3 rendered snip audio, one per revision
  media/tmp/                   in-progress downloads and renders; atomically renamed into place
```

Audio bytes never go in SQLite. A backup is the database file plus `media/`, and a restore must be tested with an active public snip.

## Invariants

1. Every `*_ms` value is relative to one `audio_asset`, reachable through its row's foreign keys.
2. `audio_asset`, `transcript`, `transcript_segment`, and `episode_summary` rows are never updated after insert, except the pointer columns on `audio_asset`. A re-download with a different checksum is a new asset, and the old one stays if any snip references it.
3. A `snip_revision` is filled in while `status` is `waiting`, `selecting`, or `preparing`, and frozen once `ready` or `failed`. An edit creates a new revision with `rev + 1`; it never modifies the old one.
4. `snip.current_revision_id` is the only path from a share token to content. A public URL serves bytes only when the snip is `active`, the current revision is `ready`, and the requested revision number equals the current one.
5. `snip_revision.excerpt` is materialized text, written from `[start_word, end_word)` at selection time. Public transcript routes read this column, never the full transcript. A later transcript correction cannot change a published quote.
6. Any asset referenced by a snip has `pinned = 1`. Cache eviction only ever touches unpinned assets, so a purge cannot break a public clip's editability.
7. `job.key` makes every enqueue idempotent. Repeated daily refreshes, retries, and manual catch-ups create no duplicate work.
8. `playback_state.seq` only increases per device. Offline replays and out-of-order requests cannot move the resume position backwards within one device; across devices the most recent `updated_at` wins.

## Shapes the API serves

These are the JSON shapes clients depend on. They are versioned by URL (`/v1`) and designed to be decoded by a Swift `Codable` struct as easily as by TypeScript.

**Transcript** (`GET /v1/transcripts/{id}`, immutable, cached forever):

```json
{
  "id": "01JB...", "asset_id": "01JA...", "language": "en", "word_count": 18422,
  "segments": [
    { "s": 12340, "e": 15800, "spk": "S1", "w0": 0,
      "words": [[12340, 12600, "So"], [12610, 12900, "the"], [12910, 13400, "thing"]] }
  ],
  "events": [[0, 9800, "music"]]
}
```

Word `w0 + i` of a segment is the global index used everywhere else. A two-hour episode is roughly 700 KB uncompressed and about 150 KB with gzip, which is small enough to cache offline on a phone.

**Snip** (`GET /v1/snips/{id}`):

```json
{
  "id": "01JC...", "asset_id": "01JA...", "episode_id": "01J9...",
  "anchor_ms": 1122000, "share_url": "https://host/s/kq7...", "share_state": "active",
  "note": null,
  "revision": {
    "id": "01JD...", "rev": 2, "method": "manual", "status": "ready",
    "start_ms": 1082150, "end_ms": 1119400, "start_word": 3011, "end_word": 3104,
    "excerpt": "…", "title": "…", "summary": "…",
    "clip_url": "https://host/m/c/01JD...?e=…&s=…", "clip_duration_ms": 37250
  }
}
```

**Create snip** (`POST /v1/snips`), the whole request a headphone gesture on iOS has to produce:

```json
{ "client_request_id": "01JE...", "asset_id": "01JA...", "anchor_ms": 1122000, "heard_from_ms": 985000 }
```

The response is the snip shape above with `status: "selecting"` and the share URL already assigned.

## Deliberately deferred

| Later entity | Why it waits |
| --- | --- |
| `episode_share` (public episode page with selected snips and a note) | A composition of existing public snips; add once snips themselves are solid |
| `refresh_run` table | Runs are recorded as `setting` rows keyed by the idempotency key, pointing at the per-feed job ids; a table is unnecessary at this size |
| `snip_candidate` (precomputed spans and cached summaries) | An optimization for selection latency; measure the runtime path first |
| `owner_id` on every table | Single owner for now; adding a column with a default is a one-line migration when a second user exists |
| Tags, Readwise and Markdown sync, legacy Snipd import | Product features over the snip table, not core functions |
