import AVFoundation
import Observation
import PlayerKit
import PodcastAPI

/// State for one snip's page: the snip, its words, playing its span, renaming it, and moving its In and Out points,
/// following web/src/screens/SnipEditor.tsx. A boundary change is a new revision on the server (PATCH with
/// if_revision) that is prepared again, so the page re-reads the snip until it is ready; a title-only change keeps
/// the revision.
@MainActor @Observable
final class SnipPageModel {
  /// How much transcript is shown around the snip when adjusting starts, and how much "Show earlier/later" adds.
  static let openMarginMs = 2 * 60_000
  static let windowStepMs = 5 * 60_000

  let snipID: ULID
  private(set) var snip: Snip?
  private(set) var episode: EpisodeDetail?
  private(set) var transcript: Transcript?
  /// Names for the transcript's speaker labels, when the server knows them.
  private(set) var speakers: [Speaker]?
  private(set) var loadError: String?
  private(set) var saveError: String?
  private(set) var saving = false
  private(set) var previewing = false
  /// Where the span's playback is, in the episode's time, while it plays.
  private(set) var previewMs: Int?

  var span = SpanPoints.Span(startMs: 0, endMs: 0)
  var title = ""
  /// While the title or the span is being edited, a fresh read of the snip doesn't overwrite them.
  var editing = false
  private(set) var window = (from: 0, to: 0)

  private let api: APIClient
  /// The span's own player; the page shows its picture when the recording is a video.
  private(set) var preview: AVPlayer?
  var previewHasVideo: Bool { episode?.asset?.videoUrl != nil }
  private var previewStop: Any?
  private var following: Task<Void, Never>?

  init(snipID: ULID, api: APIClient) {
    self.snipID = snipID
    self.api = api
  }

  var revision: SnipRevision? { snip?.revision }
  var durationMs: Int { episode?.asset?.durationMs ?? episode?.durationMs ?? max(span.endMs, 1) }
  /// Boundaries move only on a finished revision whose words are loaded, as on the web.
  var boundariesEditable: Bool { revision?.status == .ready && transcript != nil }
  var boundariesChanged: Bool { span.startMs != revision?.startMs || span.endMs != revision?.endMs }
  var titleChanged: Bool {
    let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
    return !t.isEmpty && t != (revision?.title ?? "")
  }

  func load() async {
    do {
      let snip = try await api.snip(snipID)
      apply(snip)
      episode = try await api.episode(snip.episodeId)
      try await loadTranscript()
      loadError = nil
    } catch {
      loadError = error.localizedDescription
    }
  }

  private func apply(_ snip: Snip) {
    self.snip = snip
    guard !editing, let rev = snip.revision else { return }
    span = .init(startMs: rev.startMs, endMs: rev.endMs)
    title = rev.title ?? ""
    window = (max(0, rev.startMs - Self.openMarginMs), rev.endMs + Self.openMarginMs)
  }

  /// Word ranges are read against the revision's own transcript, not the episode's current one.
  private func loadTranscript() async throws {
    guard let id = snip?.revision?.transcriptId, transcript?.id != id else { return }
    transcript = try await api.transcript(id)
    speakers = try? await api.speakers(id)
  }

  /// While the server is still choosing the moment or preparing the clip, re-read the snip every 2 s.
  func follow() {
    following?.cancel()
    following = Task { [weak self] in
      while !Task.isCancelled {
        guard let self, self.snip?.isPending ?? false else { return }
        try? await Task.sleep(for: .seconds(2))
        guard !Task.isCancelled, let fresh = try? await self.api.snip(self.snipID) else { continue }
        self.apply(fresh)
        try? await self.loadTranscript()
      }
    }
  }

  func stopFollowing() { following?.cancel() }

  // MARK: Words

  /// One voice's run of words in the snip, under the heading shown for it (nil: none, as for an article's own prose).
  struct Turn: Identifiable {
    let id: Int
    let name: String?
    let text: String
  }

  /// The snip's words by voice (`Speaker.clipTurns`, the rule the shared pages use): nil when they would show under
  /// a single heading, or none, where the excerpt reads as one block.
  var turns: [Turn]? {
    var runs: [(speaker: String?, text: String)] = []
    for segment in transcript?.segments ?? [] where segment.e >= span.startMs && segment.s <= span.endMs {
      let words = segment.words.filter { inSpan($0) }.map(\.text)
      guard !words.isEmpty else { continue }
      runs.append((segment.spk, words.joined(separator: " ")))
    }
    return Speaker.clipTurns(runs, in: speakers)?.enumerated().map { Turn(id: $0.offset, name: $0.element.name, text: $0.element.text) }
  }

  /// The snip's own words, in order: what the sideways view reads out.
  var spanWords: [Word] {
    (transcript?.segments ?? []).filter { $0.e >= span.startMs && $0.s <= span.endMs }
      .flatMap(\.words).filter { inSpan($0) }
  }

  var segmentsInWindow: [TranscriptSegment] {
    transcript?.segments.filter { $0.e >= window.from && $0.s <= window.to } ?? []
  }
  var moreEarlier: Bool { (transcript?.segments.first?.s ?? 0) < window.from }
  var moreLater: Bool { (transcript?.segments.last?.e ?? 0) > window.to }

  func showEarlier() { window.from = max(0, window.from - Self.windowStepMs) }
  func showLater() { window.to += Self.windowStepMs }

  func inSpan(_ word: Word) -> Bool { SpanPoints.wordInSpan(startMs: word.startMs, endMs: word.endMs, span: span) }

  /// A tapped word moves whichever end of the span is nearer to it: In to the word's start, or Out to its end.
  func tap(_ word: Word) {
    let toIn = abs(word.startMs - span.startMs) <= abs(word.endMs - span.endMs)
    set(toIn ? .in : .out, at: word)
  }

  /// Put one end at a word, chosen by the owner (press and hold) when the nearer end is not the one they mean: In at the
  /// word's start, or Out at its end.
  func set(_ point: SpanPoints.Point, at word: Word) {
    guard boundariesEditable else { return }
    span = SpanPoints.set(point, at: point == .in ? word.startMs : word.endMs, in: span, durationMs: durationMs)
    // A point moved past the edge of the window widens the window rather than disappearing from view.
    if span.startMs < window.from || span.endMs > window.to {
      window = (min(window.from, max(0, span.startMs - 60_000)), max(window.to, span.endMs + 60_000))
    }
    stopPreview()
  }

  /// Put the span and title back as the snip has them.
  func revert() {
    editing = false
    if let snip { apply(snip) }
  }

  // MARK: Playing the span

  /// Plays the span from the full recording on its own player, which never reports playback, so it works for a span
  /// that is being adjusted as well as for the saved one. The episode pauses and stays where it was.
  func togglePreview(pausing engine: PlayerEngine) {
    if previewing { return stopPreview() }
    // A video snip previews with its picture (the page shows the player); an audio snip with its sound.
    guard let asset = episode?.asset, let url = SignedURL.onServer(asset.videoUrl ?? asset.audioUrl, base: api.baseURL) else { return }
    engine.pause()
    let player = preview ?? makePlayer(url)
    let end = CMTime(value: CMTimeValue(span.endMs), timescale: 1000)
    if let previewStop { player.removeTimeObserver(previewStop) }
    previewStop = player.addBoundaryTimeObserver(forTimes: [NSValue(time: end)], queue: .main) { [weak self] in
      MainActor.assumeIsolated { self?.stopPreview() }
    }
    player.seek(to: CMTime(value: CMTimeValue(span.startMs), timescale: 1000), toleranceBefore: .zero, toleranceAfter: .zero)
    player.play()
    previewMs = span.startMs
    previewing = true
  }

  private func makePlayer(_ url: URL) -> AVPlayer {
    let player = AVPlayer(url: url)
    _ = player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 20), queue: .main) { [weak self] time in
      MainActor.assumeIsolated {
        guard let self, self.previewing, time.isNumeric else { return }
        self.previewMs = Int(time.seconds * 1000)
      }
    }
    preview = player
    return player
  }

  func stopPreview() {
    preview?.pause()
    previewing = false
    previewMs = nil
  }

  // MARK: Saving

  /// A change of length past this asks whether to write the summary again (the server's RESUMMARIZE_OVER_MS).
  static let resummarizeOverMs = 10_000

  /// How much longer (positive) or shorter the span being adjusted is than the saved one.
  var lengthChangeMs: Int {
    guard let rev = revision else { return 0 }
    return (span.endMs - span.startMs) - (rev.endMs - rev.startMs)
  }

  /// Saving new In/Out points asks first whether to rewrite the summary when the length changes by more than 10 s
  /// and there is a finished summary to lose; a smaller change keeps the title and summary without asking.
  var savingAsks: Bool {
    boundariesChanged && abs(lengthChangeMs) > Self.resummarizeOverMs && revision?.summaryStatus == "ready"
  }

  /// Saves a new title and/or span; `regenerate` says whether new In/Out points get a new summary. Returns false when
  /// the save failed (saveError says why).
  func save(regenerate: Bool = false) async -> Bool {
    guard let rev = revision else { return false }
    let body = EditSnip(
      startMs: boundariesChanged ? span.startMs : nil,
      endMs: boundariesChanged ? span.endMs : nil,
      title: titleChanged ? title.trimmingCharacters(in: .whitespacesAndNewlines) : nil,
      ifRevision: rev.id,
      regenerateSummary: boundariesChanged ? regenerate : nil)
    guard body.startMs != nil || body.title != nil else {
      revert()
      return true
    }
    saving = true
    defer { saving = false }
    stopPreview()
    do {
      let updated = try await api.editSnip(snipID, body)
      editing = false
      apply(updated)
      saveError = nil
      follow()
      return true
    } catch let e as APIError where e.status == 409 {
      saveError = "This snip changed elsewhere. Go back and open it again to edit the latest version."
    } catch {
      saveError = error.localizedDescription
    }
    return false
  }

  func delete() async -> Bool {
    stopPreview()
    do {
      try await api.deleteSnip(snipID)
      return true
    } catch {
      saveError = error.localizedDescription
      return false
    }
  }
}
