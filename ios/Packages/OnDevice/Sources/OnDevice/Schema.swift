import Foundation

/// The phone's tables, kept the same as the server's (`server/src/db/migrations/`) so that the queries in
/// `server/src/services` port line for line: same names, same columns, same meanings. Only the tables the phone's
/// routes read are here; a later step that needs `transcript` or `snip` adds them as a new entry in `migrations`.
///
/// Where the phone's columns mean something else:
/// - `feed.url_enc`, `episode.enclosure_url_enc`, `chapters_url_enc`, `video_url_enc` hold the URL's UTF-8 bytes,
///   not ciphertext. The server encrypts them with a secret from its environment because its database is copied in
///   backups; the phone has no such secret to keep apart from the file, and the file sits in the app's own
///   container under iOS data protection. The names stay so the SQL is the server's.
/// - `feed.url_hash` is the SHA-256 of the normalized URL (the server's is keyed with its secret). It only ever
///   answers "is this feed already here".
/// - `audio_asset` is the publisher's file, not a download: one row per episode, made with the episode, whose
///   `bytes`, `mime` and `duration_ms` are what the feed says (0 when it says nothing) and whose `sha256` and `path`
///   are empty until a later step downloads the file.
/// - `device` has one row: this phone.
enum Schema {
  /// Applied in order; `PRAGMA user_version` is how many have run. Never edit one that has shipped: add another.
  static let migrations: [String] = [
    """
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
      created_at      INTEGER NOT NULL,
      kind            TEXT NOT NULL DEFAULT 'podcast',
      text_for_feed_id TEXT REFERENCES feed(id),
      backfill        INTEGER NOT NULL DEFAULT 2,
      followed        INTEGER NOT NULL DEFAULT 1
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
      chapters_url_enc  BLOB,
      feed_chapters     TEXT,
      media_kind        TEXT NOT NULL DEFAULT 'audio',
      youtube_id        TEXT,
      video_url_enc     BLOB,
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
      path          TEXT NOT NULL,
      transcript_id TEXT,
      summary_id    TEXT,
      pinned        INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX audio_asset_episode ON audio_asset(episode_id, created_at DESC);

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
      observed_at    INTEGER,
      PRIMARY KEY (device_id, audio_asset_id)
    );
    CREATE INDEX playback_state_asset ON playback_state(audio_asset_id, updated_at DESC);

    CREATE TABLE up_next (
      episode_id TEXT PRIMARY KEY REFERENCES episode(id) ON DELETE CASCADE,
      position   REAL,
      placed_at  INTEGER,
      added_at   INTEGER,
      hidden_at  INTEGER
    );
    """
  ]

  /// Bring a database up to date. A database from a newer build (a downgrade) is left as it is.
  static func migrate(_ db: Connection) throws {
    let version = try db.get("PRAGMA user_version")?.int("user_version") ?? 0
    for (i, sql) in migrations.enumerated() where i >= version {
      try db.transaction {
        try db.exec(sql)
        try db.exec("PRAGMA user_version = \(i + 1)")
      }
    }
  }
}
