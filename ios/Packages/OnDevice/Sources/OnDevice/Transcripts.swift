import Foundation
import PodcastAPI
import SnipCore

// A port of server/src/services/transcripts.ts (storing and serving a transcript) and adBreaks.ts (the ad breaks
// found in it). The rules are the server's and SnipCore holds its pure core, so a transcript made on the phone is
// stored, served and searched for ads as the server would. What the server does next with a new transcript (wake
// waiting snips, summarize, identify speakers, map the episode) has nothing to do on the phone yet.

/// The ids ad detection read for an asset (`Inputs` in adBreaks.ts). On the phone only `asr` is ever set: it has no
/// publisher text and no summary.
struct AdInputs: Codable, Equatable {
  var asr: String?
  var publisher: String?
  var summary: String?

  var json: String { String(decoding: JSON.object(["asr": JSON(asr), "publisher": JSON(publisher), "summary": JSON(summary)]).data(), as: UTF8.self) }
}

extension Store {
  static let encoder: JSONEncoder = {
    let encoder = JSONEncoder()
    // `JSON.stringify` leaves `/` alone.
    encoder.outputFormatting = [.withoutEscapingSlashes]
    return encoder
  }()

  func transcriptRow(_ id: String) throws -> Row {
    guard let row = try db.get("SELECT * FROM transcript WHERE id = ?", [id]) else { throw HTTPError.notFound("transcript") }
    return row
  }

  /// `storeTranscript`: the transcript and its segments, made the asset's current one, in one transaction; then the
  /// asset's ad breaks, which the server's queued `detect_ads` job would find a moment later.
  @discardableResult
  func storeTranscript(assetId: String, _ t: NormalizedTranscript, costCents: Double? = nil, providerRequestId: String? = nil) throws -> String {
    let id = newId()
    let now = now()
    try db.transaction {
      try db.run(
        "INSERT INTO transcript (id, audio_asset_id, provider, model, language, word_count, events, cost_cents, provider_request_id, source, text_id, loss, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'asr', NULL, NULL, ?)",
        [id, assetId, t.provider, t.model, t.language, t.wordCount, try Self.jsonText(t.events), costCents.map { Int($0.rounded()) }, providerRequestId, now])
      for s in t.segments {
        try db.run(
          "INSERT INTO transcript_segment (transcript_id, idx, start_ms, end_ms, speaker, first_word, text, words) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [id, s.idx, s.startMs, s.endMs, s.speaker, s.firstWord, s.text, try Self.jsonText(s.words)])
      }
      try db.run("UPDATE audio_asset SET transcript_id = ? WHERE id = ?", [id, assetId])
    }
    _ = try adBreaks(assetId: assetId)
    return id
  }

  /// `loadTranscript`: the normalized transcript rebuilt from its stored segments.
  func loadTranscript(_ id: String) throws -> NormalizedTranscript {
    let row = try transcriptRow(id)
    let decoder = JSONDecoder()
    let segments = try db.all("SELECT * FROM transcript_segment WHERE transcript_id = ? ORDER BY idx", [id]).map { s in
      Segment(
        idx: s.int("idx") ?? 0, startMs: s.int("start_ms") ?? 0, endMs: s.int("end_ms") ?? 0, speaker: s.string("speaker"),
        firstWord: s.int("first_word") ?? 0, text: s.string("text") ?? "",
        words: try decoder.decode([WordTuple].self, from: Data((s.string("words") ?? "[]").utf8)))
    }
    return NormalizedTranscript(
      provider: row.string("provider") ?? "", model: row.string("model") ?? "", language: row.string("language"),
      wordCount: row.int("word_count") ?? 0, segments: segments,
      events: try decoder.decode([EventTuple].self, from: Data((row.string("events") ?? "[]").utf8)))
  }

  /// `GET /v1/transcripts/{id}` (`transcriptApi`): `toApiTranscript` with the transcript's own ids.
  func transcriptApi(_ id: String) throws -> JSON {
    let row = try transcriptRow(id)
    return try JSON(encoding: toApiTranscript(try loadTranscript(id), id: row.string("id"), assetId: row.string("audio_asset_id")))
  }

  /// `GET /v1/transcripts/{id}/speakers`: who the voices are, null until identified. The server asks its text model
  /// then; the phone has none and the recognizer labels no speakers, so it stays null (and the app shows no names).
  func speakers(transcriptId: String) throws -> JSON {
    let raw = try transcriptRow(transcriptId).string("speakers")
    guard let raw, let parsed = try? JSONDecoder().decode(JSONValue.self, from: Data(raw.utf8)),
      case .object(let members) = parsed, let speakers = members["speakers"]
    else { return ["speakers": nil] }
    return ["speakers": JSON(speakers)]
  }

  /// Whether the asset has its speech transcript (the server also counts a video's captions; the phone has none).
  func hasSpeechTranscript(assetId: String) throws -> Bool {
    try db.get("SELECT 1 AS v FROM transcript WHERE audio_asset_id = ? AND source IN ('asr', 'captions') LIMIT 1", [assetId]) != nil
  }

  // MARK: Ad breaks (server/src/services/adBreaks.ts)

  private func adInputs(assetId: String) throws -> AdInputs {
    AdInputs(
      asr: try db.get("SELECT id FROM transcript WHERE audio_asset_id = ? AND source = 'asr' ORDER BY created_at DESC LIMIT 1", [assetId])?.string("id"),
      publisher: try db.get("SELECT id FROM transcript WHERE audio_asset_id = ? AND source != 'asr' ORDER BY created_at DESC LIMIT 1", [assetId])?.string("id"),
      summary: try db.get("SELECT summary_id FROM audio_asset WHERE id = ?", [assetId])?.string("summary_id"))
  }

  /// `adBreaksFor`: the stored breaks while they came from the asset's current inputs and this detector, else
  /// computed and stored now, so a break is there the first time the episode is opened. The server falls back to a
  /// queued job when computing fails; the phone's inputs are its own rows, so a failure is a 500 here.
  func adBreaks(assetId: String) throws -> JSON {
    let want = try adInputs(assetId: assetId)
    if want.asr == nil && want.publisher == nil && want.summary == nil { return [] }
    if let row = try db.get("SELECT * FROM ad_detection WHERE audio_asset_id = ?", [assetId]),
      row.string("detector") == adDetectorVersion,
      let stored = try? JSONDecoder().decode(AdInputs.self, from: Data((row.string("inputs") ?? "").utf8)), stored == want,
      let breaks = try? JSONDecoder().decode([SnipCore.AdBreak].self, from: Data((row.string("breaks") ?? "").utf8))
    {
      return try JSON(encoding: breaks)
    }
    let breaks = try computeAdBreaks(assetId: assetId, want)
    try db.run(
      """
      INSERT INTO ad_detection (audio_asset_id, detector, inputs, breaks, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (audio_asset_id) DO UPDATE SET detector = excluded.detector, inputs = excluded.inputs, breaks = excluded.breaks, created_at = excluded.created_at
      """, [assetId, adDetectorVersion, want.json, try Self.jsonText(breaks), now()])
    return try JSON(encoding: breaks)
  }

  /// `computeAdBreaks`: speech only. Publisher text and summary chapters are the other two signals; the phone has
  /// neither, so their ids are always null and `detectAds` gets none.
  private func computeAdBreaks(assetId: String, _ inputs: AdInputs) throws -> [SnipCore.AdBreak] {
    let asset = try assetRow(assetId)
    return detectAds(AdInput(speech: try inputs.asr.map(loadTranscript), publisher: nil, chapters: nil, durationMs: asset.durationMs))
  }

  static func jsonText<T: Encodable>(_ value: T) throws -> String {
    String(decoding: try encoder.encode(value), as: UTF8.self)
  }
}

/// `languageCode` (server/src/services/transcripts.ts): `en-us` → `en`; ISO 639-1/639-3 pass through; nil when unusable.
func languageCode(_ feedLanguage: String?) -> String? {
  guard let feedLanguage else { return nil }
  let base = feedLanguage.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().split(whereSeparator: { $0 == "-" || $0 == "_" }).first.map(String.init) ?? ""
  return base.range(of: "^[a-z]{2,3}$", options: .regularExpression) != nil ? base : nil
}

extension JSON {
  /// A value the server's types encode (SnipCore's), as the phone's JSON: through its own encoding, so the keys and
  /// nulls are what that type writes.
  init<T: Encodable>(encoding value: T) throws {
    self.init(try JSONDecoder().decode(JSONValue.self, from: try Store.encoder.encode(value)))
  }

  init(_ value: JSONValue) {
    switch value {
    case .null: self = .null
    case .bool(let v): self = .bool(v)
    case .number(let v): self = v == v.rounded() && abs(v) < 9e15 ? .int(Int(v)) : .double(v)
    case .string(let v): self = .string(v)
    case .array(let v): self = .array(v.map(JSON.init))
    case .object(let v): self = .object(v.mapValues(JSON.init))
    }
  }
}
