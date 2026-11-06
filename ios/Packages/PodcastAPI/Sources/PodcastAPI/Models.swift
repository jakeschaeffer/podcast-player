import Foundation

// Models for the routes the app uses, matching server/openapi.json. Field names stay snake_case on the wire;
// APIClient's decoder converts them. Every time is integer milliseconds (Unix ms for dates, ms into the
// recording for positions), so they decode as Int and the app converts at the edge.

public typealias ULID = String

// MARK: - Shared

/// A server state the app shows but must not crash on when the server adds a value.
public protocol LenientEnum: RawRepresentable, Codable, Sendable where RawValue == String {
  static var unknown: Self { get }
}

extension LenientEnum {
  public init(from decoder: Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = Self(rawValue: raw) ?? .unknown
  }
}

public enum JobState: String, LenientEnum {
  case none, queued, running, deferred, failed, ready, unknown
}

/// A JSON value kept as-is, for decision records the app stores but does not interpret.
public enum JSONValue: Codable, Sendable, Hashable {
  case null, bool(Bool), number(Double), string(String), array([JSONValue]), object([String: JSONValue])

  public init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() { self = .null }
    else if let v = try? c.decode(Bool.self) { self = .bool(v) }
    else if let v = try? c.decode(Double.self) { self = .number(v) }
    else if let v = try? c.decode(String.self) { self = .string(v) }
    else if let v = try? c.decode([JSONValue].self) { self = .array(v) }
    else { self = .object(try c.decode([String: JSONValue].self)) }
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .null: try c.encodeNil()
    case .bool(let v): try c.encode(v)
    case .number(let v): try c.encode(v)
    case .string(let v): try c.encode(v)
    case .array(let v): try c.encode(v)
    case .object(let v): try c.encode(v)
    }
  }
}

/// A page of a list route; `next` is the cursor for `after`, nil on the last page.
public struct Page<Item: Codable & Sendable>: Codable, Sendable {
  public let items: [Item]
  public let next: String?
}

// MARK: - Devices

public struct Device: Codable, Sendable, Identifiable {
  public let id: ULID
  public let name: String
  public let platform: String
  public let createdAt: Int
  public let lastSeenAt: Int?
  public let revokedAt: Int?
}

public struct DeviceLogin: Codable, Sendable {
  public let device: Device
  /// Returned once; the app keeps it in the Keychain.
  public let token: String
}

// MARK: - Feeds

public struct Feed: Codable, Sendable, Identifiable, Hashable {
  public let id: ULID
  /// "podcast"; "text" for a publisher-text feed attached to a podcast (`textForFeedId`); "youtube" for a channel,
  /// whose episodes are videos; or "links" for the Pasted links show, the one-off files the owner pasted (followed,
  /// never refreshed, nothing to subscribe to). Library lists podcasts, channels and that show.
  public let kind: String
  public let textForFeedId: ULID?
  public let title: String?
  public let author: String?
  public let imageUrl: String?
  public let siteUrl: String?
  public let isPrivate: Bool
  public let autoProcess: Bool
  public let lastRefreshAt: Int?
  public let lastError: String?
  public let episodeCount: Int
  public let createdAt: Int
  /// In the library. A show opened from search without following it is false: manual, and out of Library and
  /// Today's new episodes. Optional so a server from before the field decodes (every feed was followed then).
  public let followed: Bool?
  /// A channel's older videos (`moreVideos`). Optional so a server from before the field decodes.
  public let moreVideos: MoreVideos?
}

/// Whether a channel's next videos can be asked for: idle, requested (the home fetcher is on it), failed (see
/// `error`), or ended (it reached the channel's first video).
public struct MoreVideos: Codable, Sendable, Hashable {
  public let status: String
  public let error: String?
}

/// `GET /v1/search/shows`: shows from the public directory (Apple Podcasts, or Podcast Index when configured).
public struct ShowSearch: Codable, Sendable {
  public struct Result: Codable, Sendable, Hashable, Identifiable {
    public let title: String
    public let author: String?
    public let feedUrl: String
    public let artworkUrl: String?
    public let siteUrl: String?
    public let episodeCount: Int?
    public let genres: [String]
    public let source: String
    /// Set when the server already has this feed, followed or not.
    public let feedId: ULID?
    /// Whether that feed is in the library; nil when there is no feed (or the server predates the field).
    public let followed: Bool?

    public var id: String { feedUrl }
  }
  public let source: String
  public let results: [Result]
}

/// `POST /v1/feeds`. The server's defaults (automatic processing, the 2 newest episodes transcribed) bill, so the app
/// always says what it wants. `followed: false` opens a show without adding it to the library; the server keeps such
/// a show manual, and the manual fields are sent anyway for a server that predates `followed`.
public struct CreateFeed: Codable, Sendable, Hashable {
  public var url: String
  public var autoProcess: Bool
  public var backfill: Int
  public var followed: Bool

  public init(url: String, autoProcess: Bool = false, backfill: Int = 0, followed: Bool = true) {
    self.url = url
    self.autoProcess = autoProcess
    self.backfill = backfill
    self.followed = followed
  }
}

/// `PATCH /v1/feeds/{id}`, as far as the app uses it: following or unfollowing a show.
public struct UpdateFeed: Codable, Sendable, Hashable {
  public var followed: Bool?

  public init(followed: Bool? = nil) {
    self.followed = followed
  }
}

// MARK: - Episodes

public struct Processing: Codable, Sendable, Hashable {
  public let audio: JobState
  public let transcript: JobState
  public let text: JobState
  public let summary: JobState
}

public struct Resume: Codable, Sendable, Hashable {
  public let positionMs: Int
  public let speed: Double
  public let finished: Bool
  public let deviceName: String?
  public let updatedAt: Int

  public init(positionMs: Int, speed: Double, finished: Bool, deviceName: String?, updatedAt: Int) {
    self.positionMs = positionMs
    self.speed = speed
    self.finished = finished
    self.deviceName = deviceName
    self.updatedAt = updatedAt
  }
}

/// An episode as lists return it.
public struct Episode: Codable, Sendable, Identifiable, Hashable {
  public let id: ULID
  public let feedId: ULID
  public let showTitle: String?
  public let title: String
  public let publishedAt: Int?
  public let durationMs: Int?
  public let imageUrl: String?
  public let assetId: ULID?
  public let transcriptId: ULID?
  public let hasSummary: Bool
  public let processing: Processing
  public let resume: Resume?
  /// "audio", or "video" when the episode is a video (a channel's, or a feed's video enclosure); the YouTube video it
  /// is or links; and where its video stands (docs/video-plan.md).
  public let mediaKind: String
  public let youtubeId: String?
  public let video: VideoState
}

/// Where an episode's video stands: none (no video exists), available (one can be fetched with
/// `requestVideo`), requested (on its way), ready (the recording has a video file), or failed (see `error`).
public struct VideoState: Codable, Sendable, Hashable {
  public let status: String
  public let error: String?
  public var isReady: Bool { status == "ready" }
  public var canRequest: Bool { status == "available" || status == "failed" }
}

extension EpisodeDetail {
  /// A channel's video that is not here yet: it opens on its details, and only asking for it starts the download.
  public var isUnfetchedChannelVideo: Bool { asset == nil && mediaKind == "video" && youtubeId != nil }
}

/// `GET /v1/queue`.
public struct QueuePage: Codable, Sendable {
  public let items: [Episode]
}

/// The body of `PUT /v1/queue`.
public struct QueueOrder: Codable, Sendable {
  public var episodeIds: [ULID]
  public init(episodeIds: [ULID]) { self.episodeIds = episodeIds }
}

public struct Chapter: Codable, Sendable, Hashable {
  public let startMs: Int
  public let endMs: Int
  public let startWord: Int?
  public let endWord: Int?
  public let title: String
  public let description: String?
  public let kind: String?
}

public struct Chapters: Codable, Sendable, Hashable {
  public let source: String
  public let transcriptId: ULID?
  public let items: [Chapter]
}

public struct PublisherText: Codable, Sendable, Hashable {
  public struct Section: Codable, Sendable, Hashable {
    public let title: String
    public let startMs: Int?
    public let startWord: Int?
  }
  public let id: ULID
  public let source: String
  public let kind: String?
  public let wordCount: Int
  public let sections: [Section]
  /// Set once the text has been aligned to the audio and became a transcript.
  public let alignedTranscriptId: ULID?
}

public struct AudioAsset: Codable, Sendable, Hashable {
  public let id: ULID
  public let durationMs: Int
  public let mime: String
  public let bytes: Int
  /// Signed and expiring (the `e` query parameter is the expiry in Unix seconds); AVPlayer plays it with no headers.
  public let audioUrl: String
  /// The recording's video file on the same timeline, signed like `audioUrl`; nil for a recording without a picture.
  public let videoUrl: String?
  public let videoWidth: Int?
  public let videoHeight: Int?
  public let videoBytes: Int?
}

public struct Takeaway: Codable, Sendable, Hashable {
  public let text: String
  public let word: Int?
}

public struct EpisodeSummary: Codable, Sendable, Hashable {
  public let id: ULID
  public let preview: String?
  public let takeaways: [Takeaway]
  public let chapters: [Chapter]?
  public let model: String?
  public let promptVersion: String?
}

/// A suspected ad break, in milliseconds on the episode's asset. The player offers "Skip ad" while one plays and seeks
/// to `endMs`; it never skips on its own.
public struct AdBreak: Codable, Sendable, Hashable {
  public let startMs: Int
  public let endMs: Int
  /// `high` when two signals agree (publisher gap, sponsor phrase, ad chapter), `medium` when one does.
  public let confidence: String
  public let sources: [String]
  public let cue: String?

  public init(startMs: Int, endMs: Int, confidence: String = "high", sources: [String] = [], cue: String? = nil) {
    self.startMs = startMs
    self.endMs = endMs
    self.confidence = confidence
    self.sources = sources
    self.cue = cue
  }
}

/// An episode as `GET /v1/episodes/{id}` returns it: the list fields plus what the player needs.
public struct EpisodeDetail: Codable, Sendable, Identifiable, Hashable {
  public let id: ULID
  public let feedId: ULID
  public let showTitle: String?
  public let title: String
  public let publishedAt: Int?
  public let durationMs: Int?
  public let imageUrl: String?
  public let assetId: ULID?
  public let transcriptId: ULID?
  public let hasSummary: Bool
  public let processing: Processing
  /// Settable so a saved copy of the episode can carry the phone's own latest position (PlayerEngine, offline).
  public var resume: Resume?
  /// "audio", or "video" when the episode is a video (a channel's, or a feed's video enclosure); the YouTube video it
  /// is or links; and where its video stands (docs/video-plan.md).
  public let mediaKind: String
  public let youtubeId: String?
  public let video: VideoState
  public let descriptionHtml: String?
  public let link: String?
  /// The publisher's own text for this episode (from a text feed or email), when there is one.
  public let text: PublisherText?
  public let chapters: Chapters?
  /// Nil until the server has fetched the recording (`POST /v1/episodes/{id}/audio`).
  public let asset: AudioAsset?
  public let summary: EpisodeSummary?
  public let snipCount: Int
  /// Empty until the server's detection has run; optional so an older server still decodes.
  public let adBreaks: [AdBreak]?
}

// MARK: - Transcripts

/// One word: the server sends `[start_ms, end_ms, text]`.
public struct Word: Codable, Sendable, Hashable {
  public let startMs: Int
  public let endMs: Int
  public let text: String

  public init(startMs: Int, endMs: Int, text: String) {
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

public struct TranscriptSegment: Codable, Sendable, Hashable {
  public let s: Int
  public let e: Int
  public let spk: String?
  /// Global index of this segment's first word.
  public let w0: Int
  public let words: [Word]

  public init(s: Int, e: Int, spk: String?, w0: Int, words: [Word]) {
    self.s = s
    self.e = e
    self.spk = spk
    self.w0 = w0
    self.words = words
  }
}

/// One of a transcript's voices: the show's host, a guest, or anyone else, named only when the publisher says who.
public struct Speaker: Codable, Sendable, Hashable {
  public let label: String
  public let role: String
  public let name: String?

  public init(label: String, role: String, name: String?) {
    self.label = label
    self.role = role
    self.name = name
  }

  /// What a label is shown as: the name when known, else "Host" or "Guest", else "Speaker 2".
  public static func displayName(_ label: String, in speakers: [Speaker]?) -> String {
    let who = speakers?.first { $0.label == label }
    if let name = who?.name { return name }
    switch who?.role {
    case "host": return "Host"
    case "guest": return "Guest"
    default: return "Speaker \(label.drop { $0 == "S" })"
    }
  }
}

public struct SpeakersResponse: Codable, Sendable {
  public let speakers: [Speaker]?
}

public struct Transcript: Codable, Sendable {
  public let id: ULID?
  public let assetId: ULID?
  public let language: String?
  public let wordCount: Int
  public let segments: [TranscriptSegment]
}

// MARK: - Playback

public struct PlaybackReport: Codable, Sendable, Hashable {
  public var positionMs: Int
  public var speed: Double
  public var playing: Bool
  public var finished: Bool
  /// Per-device, increasing; the server drops a report older than one it already has.
  public var seq: Int
  /// When the phone observed this position (Unix ms), so a replay after a flight cannot overwrite newer progress.
  public var observedAt: Int

  public init(positionMs: Int, speed: Double, playing: Bool, finished: Bool, seq: Int, observedAt: Int) {
    self.positionMs = positionMs
    self.speed = speed
    self.playing = playing
    self.finished = finished
    self.seq = seq
    self.observedAt = observedAt
  }
}

public struct PlaybackAck: Codable, Sendable {
  public let accepted: Bool
  public let positionMs: Int
  public let speed: Double
  public let playing: Bool
  public let finished: Bool
  public let seq: Int
  public let updatedAt: Int
}

// MARK: - Snips

public enum SnipStatus: String, LenientEnum {
  case waiting, selecting, preparing, ready, failed, unknown

  /// Still on its way: the card keeps polling.
  public var isPending: Bool { self == .waiting || self == .selecting || self == .preparing }
}

public struct SnipRevision: Codable, Sendable, Identifiable, Hashable {
  public let id: ULID
  public let rev: Int
  public let method: String
  public let status: SnipStatus
  public let transcriptId: ULID?
  public let startMs: Int
  public let endMs: Int
  public let startWord: Int?
  public let endWord: Int?
  public let excerpt: String?
  public let title: String?
  public let titleSource: String?
  /// Since snip-summary v3, bullets, one per line; earlier summaries are prose.
  public let summary: String?
  /// A line copied word for word from the excerpt, chosen by the summary; nil when there is none.
  public let quote: String?
  public let summaryStatus: String
  public let clipUrl: String?
  public let clipDurationMs: Int?
  public let error: String?
  public let selection: JSONValue?
  public let createdAt: Int
}

public struct Snip: Codable, Sendable, Identifiable, Hashable {
  public let id: ULID
  public let assetId: ULID
  public let episodeId: ULID
  public let episodeTitle: String
  public let showTitle: String?
  /// The episode's artwork, else its show's.
  public let imageUrl: String?
  /// "audio" or "video": which of the episode's recordings the snip was cut from. An episode's snips are one list in
  /// time order whichever recording each came from.
  public let mediaKind: String
  public let anchorMs: Int
  public let heardFromMs: Int
  public let shareUrl: String
  public let shareState: String
  public let note: String?
  public let createdAt: Int
  public let capturedAt: Int?
  public let revision: SnipRevision?

  /// Like the web's isPending: no revision yet counts as pending.
  public var isPending: Bool { revision?.status.isPending ?? true }
}

public struct CreateSnip: Codable, Sendable, Hashable {
  /// Makes a replayed tap return the same snip (HTTP 200) instead of a second one.
  public var clientRequestId: String
  public var assetId: ULID
  public var anchorMs: Int
  public var heardFromMs: Int
  public var capturedAt: Int

  public init(clientRequestId: String, assetId: ULID, anchorMs: Int, heardFromMs: Int, capturedAt: Int) {
    self.clientRequestId = clientRequestId
    self.assetId = assetId
    self.anchorMs = anchorMs
    self.heardFromMs = heardFromMs
    self.capturedAt = capturedAt
  }
}

/// `PATCH /v1/snips/{id}`. Boundaries are sent only when they changed, so a title-only save stays on the same
/// revision; `ifRevision` is always sent, so a replayed edit is refused (409) rather than duplicated.
public struct EditSnip: Codable, Sendable, Hashable {
  public var startMs: Int?
  public var endMs: Int?
  public var title: String?
  public var ifRevision: ULID
  /// With new In/Out points: write the title and summary again (true) or keep them (false). Left out, the server
  /// writes them again only when the length changes by more than 10 s.
  public var regenerateSummary: Bool?

  public init(startMs: Int? = nil, endMs: Int? = nil, title: String? = nil, ifRevision: ULID, regenerateSummary: Bool? = nil) {
    self.startMs = startMs
    self.endMs = endMs
    self.title = title
    self.ifRevision = ifRevision
    self.regenerateSummary = regenerateSummary
  }
}

// MARK: - Prompts and evals

/// An eval's pass rate: `rate` is passed / n, `margin` the half-width of its 95% interval.
public struct EvalScore: Codable, Sendable, Hashable {
  public let passed: Int
  public let n: Int
  public let rate: Double
  public let margin: Double
}

/// The eval that scores a prompt, e.g. `titles` for the snip summary.
public struct EvalRef: Codable, Sendable, Hashable {
  public let id: String
  public let label: String
}

/// `GET /v1/prompts`: one prompt with its versions (newest first) and the one production uses.
public struct Prompt: Codable, Sendable, Identifiable, Hashable {
  public struct Version: Codable, Sendable, Identifiable, Hashable {
    public let version: String
    public let createdAt: Int
    public let active: Bool
    /// The version's latest finished run.
    public let score: EvalScore?

    public var id: String { version }
  }
  public let name: String
  public let label: String
  public let active: String
  /// False when production never calls this prompt (the span picker is off, or there is no text model).
  public let inUse: Bool
  public let eval: EvalRef?
  public let versions: [Version]

  public var id: String { name }
}

public enum EvalRunStatus: String, LenientEnum {
  case queued, running, done, failed, unknown

  public var isPending: Bool { self == .queued || self == .running }
}

public struct EvalRun: Codable, Sendable, Identifiable, Hashable {
  public struct Progress: Codable, Sendable, Hashable {
    public let done: Int
    public let total: Int
  }
  public let id: String
  public let eval: String
  public let version: String?
  public let runAt: Int
  public let status: EvalRunStatus
  public let score: EvalScore?
  public let progress: Progress?
  public let error: String?
}

/// `GET /v1/prompts/{name}/versions/{version}`: the text, the version before it (for its changes), and its runs.
public struct PromptVersion: Codable, Sendable, Hashable {
  public struct Previous: Codable, Sendable, Hashable {
    public let version: String
    public let text: String
  }
  public let name: String
  public let label: String
  public let version: String
  public let text: String
  public let createdAt: Int
  public let active: Bool
  public let previous: Previous?
  public let eval: EvalRef?
  public let runs: [EvalRun]
}

/// `GET /v1/evals/{eval}/runs/{run}`: the run and every case, failures first.
public struct EvalRunDetail: Codable, Sendable {
  public struct Case: Codable, Sendable, Identifiable, Hashable {
    public let id: String
    public let pass: Bool
    public let score: Int?
    public let expected: String
    public let actual: String
    public let note: String?
  }
  public let run: EvalRun
  public let cases: [Case]
}

// MARK: - Sharing and status

public struct EpisodeShare: Codable, Sendable {
  public let shareUrl: String?
  public let state: String
  public let snipCount: Int
  public let createdAt: Int?
}

public struct Health: Codable, Sendable {
  public let ok: Bool
}
