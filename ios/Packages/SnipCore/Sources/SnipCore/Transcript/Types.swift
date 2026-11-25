import Foundation

// A port of server/src/core/transcript/types.ts. Change the TypeScript first, never this port alone.
//
// Conventions (docs/core/README.md):
// - Every time is integer milliseconds from the start of one audio asset.
// - Words are the coordinate system: after normalization every word has a global index `0..<wordCount` that never
//   changes for the life of the transcript.
//
// Each type encodes to the JSON the server stores and serves, so the phone's own backend can keep and answer with
// the same shapes: snake_case keys, words and events as three-element arrays, and `null` written out where the
// server writes one (JSONEncoder would otherwise leave the key out).

/// `RawWord` (server/src/core/transcript/types.ts): a spoken word as a provider returned it, already converted to
/// milliseconds.
///
/// Times are `Double` because a provider's are not yet whole or even finite; `normalize` rounds them and drops the
/// words it cannot place. JSON has no NaN or infinity: to read one, give the decoder a
/// `nonConformingFloatDecodingStrategy`.
public struct RawWord: Sendable, Equatable, Codable {
  public var text: String
  public var startMs: Double
  public var endMs: Double
  /// Provider speaker label (for example `speaker_0`). Relabelled to S1, S2… by the normalizer.
  public var speaker: String?
  /// 0...1 when the provider exposes one.
  public var confidence: Double?

  public init(text: String, startMs: Double, endMs: Double, speaker: String? = nil, confidence: Double? = nil) {
    self.text = text
    self.startMs = startMs
    self.endMs = endMs
    self.speaker = speaker
    self.confidence = confidence
  }

  enum CodingKeys: String, CodingKey {
    case text, speaker, confidence
    case startMs = "start_ms"
    case endMs = "end_ms"
  }
}

/// `RawEvent` (server/src/core/transcript/types.ts): a non-speech sound the provider tagged, such as music or laughter.
public struct RawEvent: Sendable, Equatable, Codable {
  public var label: String
  public var startMs: Double
  public var endMs: Double

  public init(label: String, startMs: Double, endMs: Double) {
    self.label = label
    self.startMs = startMs
    self.endMs = endMs
  }

  enum CodingKeys: String, CodingKey {
    case label
    case startMs = "start_ms"
    case endMs = "end_ms"
  }
}

/// `RawTranscript` (server/src/core/transcript/types.ts): provider output after the adapter mapped it, before
/// normalization.
public struct RawTranscript: Sendable, Equatable, Codable {
  public var provider: String
  public var model: String
  /// ISO 639 code as reported, or nil when unknown.
  public var language: String?
  public var words: [RawWord]
  public var events: [RawEvent]
  /// Audio duration as the provider measured it, if reported.
  public var durationMs: Double?
  /// Estimated cost from the configured rate, if known.
  public var costCents: Double?
  /// Provider-side identifier for the request, for support and the usage ledger.
  public var providerRequestId: String?

  public init(
    provider: String, model: String, language: String?, words: [RawWord], events: [RawEvent] = [],
    durationMs: Double? = nil, costCents: Double? = nil, providerRequestId: String? = nil
  ) {
    self.provider = provider
    self.model = model
    self.language = language
    self.words = words
    self.events = events
    self.durationMs = durationMs
    self.costCents = costCents
    self.providerRequestId = providerRequestId
  }

  enum CodingKeys: String, CodingKey {
    case provider, model, language, words, events
    case durationMs = "duration_ms"
    case costCents = "cost_cents"
    case providerRequestId = "provider_request_id"
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    provider = try c.decode(String.self, forKey: .provider)
    model = try c.decode(String.self, forKey: .model)
    language = try c.decodeIfPresent(String.self, forKey: .language)
    words = try c.decode([RawWord].self, forKey: .words)
    events = try c.decode([RawEvent].self, forKey: .events)
    durationMs = try c.decodeIfPresent(Double.self, forKey: .durationMs)
    costCents = try c.decodeIfPresent(Double.self, forKey: .costCents)
    providerRequestId = try c.decodeIfPresent(String.self, forKey: .providerRequestId)
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(provider, forKey: .provider)
    try c.encode(model, forKey: .model)
    try c.encode(language, forKey: .language)  // `string | null`: always present
    try c.encode(words, forKey: .words)
    try c.encode(events, forKey: .events)
    try c.encodeIfPresent(durationMs, forKey: .durationMs)
    try c.encodeIfPresent(costCents, forKey: .costCents)
    try c.encodeIfPresent(providerRequestId, forKey: .providerRequestId)
  }
}

/// `WordTuple` (server/src/core/transcript/types.ts): `[start_ms, end_ms, text]`, the compact word form stored and
/// served.
public struct WordTuple: Sendable, Equatable, Codable {
  public var startMs: Int
  public var endMs: Int
  public var text: String

  public init(_ startMs: Int, _ endMs: Int, _ text: String) {
    self.startMs = startMs
    self.endMs = endMs
    self.text = text
  }

  public init(from decoder: Decoder) throws {
    var c = try decoder.unkeyedContainer()
    startMs = try c.decode(Int.self)
    endMs = try c.decode(Int.self)
    text = try c.decode(String.self)
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.unkeyedContainer()
    try c.encode(startMs)
    try c.encode(endMs)
    try c.encode(text)
  }
}

/// `EventTuple` (server/src/core/transcript/types.ts): `[start_ms, end_ms, label]`.
public struct EventTuple: Sendable, Equatable, Codable {
  public var startMs: Int
  public var endMs: Int
  public var label: String

  public init(_ startMs: Int, _ endMs: Int, _ label: String) {
    self.startMs = startMs
    self.endMs = endMs
    self.label = label
  }

  public init(from decoder: Decoder) throws {
    var c = try decoder.unkeyedContainer()
    startMs = try c.decode(Int.self)
    endMs = try c.decode(Int.self)
    label = try c.decode(String.self)
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.unkeyedContainer()
    try c.encode(startMs)
    try c.encode(endMs)
    try c.encode(label)
  }
}

/// `Segment` (server/src/core/transcript/types.ts): one stored transcript segment, a run of words by one speaker,
/// split at long pauses and capped in length.
///
/// The keys are the `transcript_segment` columns (server/src/services/transcripts.ts), where `words` is held as
/// JSON text: `[[start_ms, end_ms, text], …]`, which is what `[WordTuple]` encodes to.
public struct Segment: Sendable, Equatable, Codable {
  public var idx: Int
  public var startMs: Int
  public var endMs: Int
  /// `S1`, `S2`… by order of first appearance, or nil when the provider gave no speakers.
  public var speaker: String?
  /// Global index of the first word in this segment.
  public var firstWord: Int
  /// Words joined with single spaces; what full-text search indexes.
  public var text: String
  public var words: [WordTuple]

  public init(idx: Int, startMs: Int, endMs: Int, speaker: String?, firstWord: Int, text: String, words: [WordTuple]) {
    self.idx = idx
    self.startMs = startMs
    self.endMs = endMs
    self.speaker = speaker
    self.firstWord = firstWord
    self.text = text
    self.words = words
  }

  enum CodingKeys: String, CodingKey {
    case idx, speaker, text, words
    case startMs = "start_ms"
    case endMs = "end_ms"
    case firstWord = "first_word"
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    idx = try c.decode(Int.self, forKey: .idx)
    startMs = try c.decode(Int.self, forKey: .startMs)
    endMs = try c.decode(Int.self, forKey: .endMs)
    speaker = try c.decodeIfPresent(String.self, forKey: .speaker)
    firstWord = try c.decode(Int.self, forKey: .firstWord)
    text = try c.decode(String.self, forKey: .text)
    words = try c.decode([WordTuple].self, forKey: .words)
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(idx, forKey: .idx)
    try c.encode(startMs, forKey: .startMs)
    try c.encode(endMs, forKey: .endMs)
    try c.encode(speaker, forKey: .speaker)  // `string | null`: always present
    try c.encode(firstWord, forKey: .firstWord)
    try c.encode(text, forKey: .text)
    try c.encode(words, forKey: .words)
  }
}

/// `NormalizedTranscript` (server/src/core/transcript/types.ts): the normalized, immutable transcript.
///
/// `provider`, `model`, `language`, `wordCount` and `events` are the `transcript` row's columns of the same names
/// (`events` as JSON text there); `segments` are its `transcript_segment` rows in `idx` order.
public struct NormalizedTranscript: Sendable, Equatable, Codable {
  public var provider: String
  public var model: String
  public var language: String?
  public var wordCount: Int
  public var segments: [Segment]
  public var events: [EventTuple]

  public init(provider: String, model: String, language: String?, wordCount: Int, segments: [Segment], events: [EventTuple]) {
    self.provider = provider
    self.model = model
    self.language = language
    self.wordCount = wordCount
    self.segments = segments
    self.events = events
  }

  enum CodingKeys: String, CodingKey {
    case provider, model, language, segments, events
    case wordCount = "word_count"
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    provider = try c.decode(String.self, forKey: .provider)
    model = try c.decode(String.self, forKey: .model)
    language = try c.decodeIfPresent(String.self, forKey: .language)
    wordCount = try c.decode(Int.self, forKey: .wordCount)
    segments = try c.decode([Segment].self, forKey: .segments)
    events = try c.decode([EventTuple].self, forKey: .events)
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(provider, forKey: .provider)
    try c.encode(model, forKey: .model)
    try c.encode(language, forKey: .language)
    try c.encode(wordCount, forKey: .wordCount)
    try c.encode(segments, forKey: .segments)
    try c.encode(events, forKey: .events)
  }
}

/// One segment of an `ApiTranscript` (server/src/core/transcript/types.ts), as `GET /v1/transcripts/{id}` serves it:
/// `{s, e, spk, w0, words}`.
public struct ApiSegment: Sendable, Equatable, Codable {
  public var s: Int
  public var e: Int
  public var spk: String?
  /// Global index of this segment's first word.
  public var w0: Int
  public var words: [WordTuple]

  public init(s: Int, e: Int, spk: String?, w0: Int, words: [WordTuple]) {
    self.s = s
    self.e = e
    self.spk = spk
    self.w0 = w0
    self.words = words
  }

  enum CodingKeys: String, CodingKey { case s, e, spk, w0, words }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    s = try c.decode(Int.self, forKey: .s)
    e = try c.decode(Int.self, forKey: .e)
    spk = try c.decodeIfPresent(String.self, forKey: .spk)
    w0 = try c.decode(Int.self, forKey: .w0)
    words = try c.decode([WordTuple].self, forKey: .words)
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(s, forKey: .s)
    try c.encode(e, forKey: .e)
    try c.encode(spk, forKey: .spk)
    try c.encode(w0, forKey: .w0)
    try c.encode(words, forKey: .words)
  }
}

/// `ApiTranscript` (server/src/core/transcript/types.ts): the shape `GET /v1/transcripts/{id}` serves
/// (docs/core/data-model.md), and the shape contracts/golden holds transcripts in.
public struct ApiTranscript: Sendable, Equatable, Codable {
  public var id: String?
  public var assetId: String?
  public var language: String?
  public var wordCount: Int
  public var segments: [ApiSegment]
  public var events: [EventTuple]

  public init(id: String? = nil, assetId: String? = nil, language: String?, wordCount: Int, segments: [ApiSegment], events: [EventTuple]) {
    self.id = id
    self.assetId = assetId
    self.language = language
    self.wordCount = wordCount
    self.segments = segments
    self.events = events
  }

  enum CodingKeys: String, CodingKey {
    case id, language, segments, events
    case assetId = "asset_id"
    case wordCount = "word_count"
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decodeIfPresent(String.self, forKey: .id)
    assetId = try c.decodeIfPresent(String.self, forKey: .assetId)
    language = try c.decodeIfPresent(String.self, forKey: .language)
    wordCount = try c.decode(Int.self, forKey: .wordCount)
    segments = try c.decode([ApiSegment].self, forKey: .segments)
    events = try c.decode([EventTuple].self, forKey: .events)
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encodeIfPresent(id, forKey: .id)
    try c.encodeIfPresent(assetId, forKey: .assetId)
    try c.encode(language, forKey: .language)
    try c.encode(wordCount, forKey: .wordCount)
    try c.encode(segments, forKey: .segments)
    try c.encode(events, forKey: .events)
  }
}

/// `toApiTranscript` (server/src/core/transcript/types.ts): the transcript as the API serves it, with its ids when it
/// has been stored.
public func toApiTranscript(_ t: NormalizedTranscript, id: String? = nil, assetId: String? = nil) -> ApiTranscript {
  ApiTranscript(
    id: id, assetId: assetId, language: t.language, wordCount: t.wordCount,
    segments: t.segments.map { ApiSegment(s: $0.startMs, e: $0.endMs, spk: $0.speaker, w0: $0.firstWord, words: $0.words) },
    events: t.events)
}

extension NormalizedTranscript {
  /// The transcript an API answer describes, the other way from `toApiTranscript`. The API shape leaves out what the
  /// words already say, so a segment's `idx` is its position and its `text` its words joined by single spaces, as
  /// `normalize` builds them; the provider and model are not served, so the caller names them.
  ///
  /// The TypeScript has no one function for this: the server rebuilds a transcript from its rows (`loadTranscript`
  /// in server/src/services/transcripts.ts), and its golden tests from the API shape (`fromApiTranscript` in
  /// server/test/helpers/transcript.ts), which is the rule followed here.
  public init(api: ApiTranscript, provider: String = "", model: String = "") {
    self.init(
      provider: provider, model: model, language: api.language, wordCount: api.wordCount,
      segments: api.segments.enumerated().map { idx, s in
        Segment(
          idx: idx, startMs: s.s, endMs: s.e, speaker: s.spk, firstWord: s.w0,
          text: s.words.map(\.text).joined(separator: " "), words: s.words)
      },
      events: api.events)
  }
}
