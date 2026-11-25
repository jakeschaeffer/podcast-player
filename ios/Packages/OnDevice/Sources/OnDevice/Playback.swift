import Foundation

// A port of server/src/services/playback.ts.

/// The body of `PUT /v1/playback/{asset_id}` (`PlaybackBody` in server/src/http/schemas.ts).
struct PlaybackReportInput: Sendable {
  var positionMs: Double
  var speed: Double
  var playing: Bool
  var finished: Bool
  var seq: Int
  var observedAt: Double?
}

extension Store {
  /// Two recordings of an episode this close in length are taken to be the same cut, so a place in one holds in the other.
  static let sameCutToleranceMs = 1000

  /// Copy the place on one recording to another of the same cut, for one device or all of them. The newest
  /// observed place wins, so a replayed report cannot move a device back. The copy keeps the seq, so the device's
  /// next report is accepted. Returns whether anything changed; recordings of different lengths keep their own.
  ///
  /// Nothing on the phone gives an episode a second recording yet (each has the one made with it); this is here
  /// for the step that downloads the file, when the episode's current recording will move as it does on the server.
  @discardableResult
  func carryPlace(from fromAssetId: String, to toAssetId: String, deviceId: String? = nil) throws -> Bool {
    let lengths = try db.all("SELECT id, duration_ms FROM audio_asset WHERE id IN (?, ?)", [fromAssetId, toAssetId])
    guard let from = lengths.first(where: { $0.string("id") == fromAssetId })?.int("duration_ms"),
      let to = lengths.first(where: { $0.string("id") == toAssetId })?.int("duration_ms"),
      abs(from - to) <= Self.sameCutToleranceMs
    else { return false }
    let changes = try db.run(
      """
      INSERT INTO playback_state (device_id, audio_asset_id, position_ms, speed, playing, finished, seq, updated_at, observed_at)
      SELECT device_id, ?, MIN(position_ms, ?), speed, 0, finished, seq, updated_at, observed_at FROM playback_state
      WHERE audio_asset_id = ? AND (? IS NULL OR device_id = ?)
      ON CONFLICT (device_id, audio_asset_id) DO UPDATE SET position_ms = excluded.position_ms, speed = excluded.speed, playing = 0, finished = excluded.finished, seq = MAX(seq, excluded.seq), updated_at = excluded.updated_at, observed_at = excluded.observed_at
      WHERE COALESCE(excluded.observed_at, excluded.updated_at) > COALESCE(observed_at, updated_at)
      """, [toAssetId, to, fromAssetId, deviceId, deviceId])
    return changes > 0
  }

  /// Record this phone's playback state. A `seq` not greater than the stored one is ignored, so offline replays
  /// and reordered requests cannot move it backwards. Returns the server's ack: whether it was taken, and the state
  /// that now stands.
  ///
  /// The phone differs in two ways. The position is not capped at the recording's length: the server caps it at
  /// the measured length of its own file, and the phone has only the feed's figure, which is absent for some shows
  /// (it would cap every position to 0) and short of the real file wherever ads are inserted. And playing queues
  /// no summary or episode map (the phone makes neither); transcription is queued by `queueTranscriptionForPlay`,
  /// which the route calls after this.
  ///
  /// Up next needs no write here: it is read from these rows (`listQueue`), where the newest observed report of an
  /// episode decides whether it is half-heard and when it was last listened to.
  func reportPlayback(assetId: String, _ report: PlaybackReportInput) throws -> JSON {
    let asset = try assetRow(assetId)
    let position = max(0, Int(report.positionMs.rounded()))
    let existing = try db.get("SELECT * FROM playback_state WHERE device_id = ? AND audio_asset_id = ?", [deviceId, assetId])
    if let existing, report.seq <= existing.int("seq") ?? 0 { return Self.ack(accepted: false, existing) }
    let now = now()
    // A device clock running fast must not make its reports win every comparison.
    let observedAt = report.observedAt.map { min(Int($0.rounded()), now) }
    try db.run(
      """
      INSERT INTO playback_state (device_id, audio_asset_id, position_ms, speed, playing, finished, seq, updated_at, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (device_id, audio_asset_id) DO UPDATE SET position_ms = excluded.position_ms, speed = excluded.speed, playing = excluded.playing, finished = excluded.finished, seq = excluded.seq, updated_at = excluded.updated_at, observed_at = excluded.observed_at
      """, [deviceId, assetId, position, report.speed, report.playing, report.finished, report.seq, now, observedAt])
    // A device can still be playing the recording the episode has moved on from; its place follows to the current one.
    let current = try db.get("SELECT current_asset_id FROM episode WHERE id = ?", [asset.episodeId])?.string("current_asset_id")
    if let current, current != assetId { try carryPlace(from: assetId, to: current, deviceId: deviceId) }
    guard let state = try db.get("SELECT * FROM playback_state WHERE device_id = ? AND audio_asset_id = ?", [deviceId, assetId]) else {
      throw HTTPError.notFound("audio asset")
    }
    return Self.ack(accepted: true, state)
  }

  /// Playing an untranscribed recording queues its transcription (the server's `reportPlayback`), at a priority
  /// below an episode asked for (`JobPriority`). The server does this only for `auto_process` shows, because it
  /// bills; on the phone it costs nothing and stays on the phone, so every show's episode is transcribed once played.
  /// Only when it has no job yet: one that failed is not queued again by playing (the server would), so a recording
  /// that cannot be transcribed is not fetched again at every report; Transcribe ("Try again") queues it again.
  /// Returns whether a job was queued.
  func queueTranscriptionForPlay(assetId: String) throws -> Bool {
    let asset = try assetRow(assetId)
    guard asset.transcriptId == nil, try db.get("SELECT 1 AS v FROM job WHERE key = ?", [Self.transcribeKey(assetId)]) == nil else { return false }
    return try enqueueTranscription(assetId: assetId, priority: JobPriority.played)
  }

  private static func ack(accepted: Bool, _ state: Row) -> JSON {
    [
      "accepted": .bool(accepted), "position_ms": .int(state.int("position_ms") ?? 0), "speed": .double(state.double("speed") ?? 1),
      "playing": .bool(state.bool("playing")), "finished": .bool(state.bool("finished")), "seq": .int(state.int("seq") ?? 0),
      "updated_at": .int(state.int("updated_at") ?? 0),
    ]
  }

  /// Most recent state across devices, by when each position was observed: a report replayed after a flight is
  /// placed at the time it happened, not when it arrived. A deliberate rewind wins over an older further position.
  func resume(assetId: String) throws -> JSON {
    guard
      let row = try db.get(
        """
        SELECT p.*, d.name AS device_name, COALESCE(p.observed_at, p.updated_at) AS at FROM playback_state p JOIN device d ON d.id = p.device_id
        WHERE p.audio_asset_id = ? ORDER BY at DESC LIMIT 1
        """, [assetId])
    else { return .null }
    return [
      "position_ms": .int(row.int("position_ms") ?? 0), "speed": .double(row.double("speed") ?? 1), "finished": .bool(row.bool("finished")),
      "device_name": JSON(row.string("device_name")), "updated_at": .int(row.int("at") ?? 0),
    ]
  }
}
