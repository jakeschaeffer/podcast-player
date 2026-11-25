import Foundation

/// The phone's database and everything that reads or writes it. An actor, so one request's reads and writes never
/// interleave with another's: each service function below runs start to finish like one of the server's
/// synchronous functions over better-sqlite3. Nothing here touches the network; `LocalBackend` fetches, then hands
/// the result in.
///
/// The service functions live in extensions, one file per server file they port:
/// Feeds.swift (services/feeds.ts), Episodes.swift (services/episodes.ts), Playback.swift (services/playback.ts),
/// Transcripts.swift (services/transcripts.ts and adBreaks.ts), Jobs.swift (jobs/queue.ts).
actor Store {
  static let fileName = "ondevice.sqlite"

  let db: Connection
  /// Where the database is, and the downloaded recordings under `audio/`.
  let folder: URL
  /// The one row of `device`: whose position `resume` reports, and whose name it carries.
  let deviceId: String
  private let clock: @Sendable () -> Date
  private var ids = ULIDGenerator()

  init(folder: URL, deviceName: String, now: @escaping @Sendable () -> Date, runningHere: Set<String> = []) throws {
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let db = try Connection(path: folder.appending(path: Self.fileName).path(percentEncoded: false))
    // The pragmas the server opens with (server/src/db/index.ts).
    try db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")
    try Schema.migrate(db)
    let nowMs = Int((now().timeIntervalSince1970 * 1000).rounded())
    if let existing = try db.get("SELECT id FROM device ORDER BY created_at LIMIT 1")?.string("id") {
      // The phone can be renamed between launches; `resume.device_name` shows the name it has now.
      try db.run("UPDATE device SET name = ?, last_seen_at = ? WHERE id = ?", [deviceName, nowMs, existing])
      deviceId = existing
    } else {
      var first = ULIDGenerator()
      let id = first.next(nowMs: nowMs)
      // There is no login on the phone, so no token to hash; the column is the server's and must be unique.
      try db.run(
        "INSERT INTO device (id, name, platform, token_hash, created_at, last_seen_at) VALUES (?, ?, 'ios', 'on-device', ?, ?)",
        [id, deviceName, nowMs, nowMs])
      deviceId = id
    }
    self.db = db
    self.folder = folder
    self.clock = now
    try Self.recoverInterruptedJobs(db, nowMs: nowMs, runningHere: runningHere)
  }

  /// Unix ms, the server's `ctx.now()`.
  func now() -> Int { Int((clock().timeIntervalSince1970 * 1000).rounded()) }

  func newId() -> String { ids.next(nowMs: now()) }
}
