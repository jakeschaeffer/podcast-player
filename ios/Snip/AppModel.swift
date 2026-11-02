import Foundation
import Observation
import PlayerKit
import PodcastAPI
import SnipActivity
import SyncKit
import UIKit

/// Wires the client, the player engine and the outboxes together for one server, and owns sign-in state.
@MainActor @Observable
final class AppModel {
  static let serverKey = "server.url"
  nonisolated static let unauthorized = Notification.Name("AppModel.unauthorized")

  private(set) var serverURL: URL
  private(set) var signedIn: Bool
  private(set) var api: APIClient
  private(set) var engine: PlayerEngine
  /// Recordings kept on the phone, with their episodes' details and transcripts, for playing with no connection.
  private(set) var downloads: DownloadStore
  /// Show artwork by feed id, for episodes that have none of their own (Stratechery's don't).
  private(set) var showArtwork: [ULID: String] = [:]
  /// Shows opened from search without following them: their episodes stay out of Today's new episodes.
  private(set) var unfollowedFeeds: Set<ULID> = []
  private var tokens: TokenStore
  private var reporter: PlaybackReporter
  private var snips: SnipOutbox
  /// The card for the latest snip tap, shown in the player until closed.
  var snipCard: SnipCardModel?
  /// A snip's page is showing its words sideways, full screen; the mini player hides meanwhile.
  var readingSideways = false
  /// Up next in the owner's order, without the one playing (`refreshQueue`): ones heard partway and not yet placed
  /// first, last listened first, then the ones placed or added.
  private(set) var queue: [Episode] = []
  /// The episode just left for another, until the server's queue has caught up with its final report.
  private var justLeft: ULID?
  private let liveActivity = LiveActivityController()
  private let sounds = SnipSounds()

  /// The server this build names in Info.plist (`PodcastServerURL`, from Config/Signing.xcconfig and Local.xcconfig),
  /// if any: a shared build names none, and its login screen starts blank.
  static var defaultServer: URL? {
    guard let fromPlist = Bundle.main.object(forInfoDictionaryKey: "PodcastServerURL") as? String, !fromPlist.isEmpty else { return nil }
    return URL(string: fromPlist)
  }
  /// What the login screen offers: the server last signed in to on this phone, else the build's default.
  var suggestedServer: String? {
    UserDefaults.standard.string(forKey: Self.serverKey) ?? Self.defaultServer?.absoluteString
  }

  init() {
    let saved = UserDefaults.standard.string(forKey: Self.serverKey).flatMap(URL.init(string:))
    // With nothing to offer, the model still needs a client to hold; nothing is called before sign-in.
    var server = saved ?? Self.defaultServer ?? URL(string: "http://localhost:8080")!
    #if DEBUG
      if TokenStore(server: server).load() == nil, let dev = DevAuth.load() {
        server = dev.server
        TokenStore(server: server).save(dev.token)
      }
    #endif
    let parts = Self.connect(to: server)
    (serverURL, tokens, api, reporter, engine, snips, downloads) = (server, parts.tokens, parts.api, parts.reporter, parts.engine, parts.snips, parts.downloads)
    signedIn = parts.tokens.load() != nil
    // The share sheet reads the server from the Keychain (SharedSession); a build from before it wrote nothing there.
    if signedIn { SharedSession.rememberServer(server) }
    listenForDeliveredSnips()
    wireQueue()
    wireLiveActivity()
    // Any 401 outside login means the device was revoked or the token is gone: back to the login screen.
    NotificationCenter.default.addObserver(forName: Self.unauthorized, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.signOut() }
    }
  }

  // MARK: Sign-in

  func signIn(server: URL, password: String) async throws {
    let login = try await APIClient(baseURL: server, token: { nil })
      .login(password: password, deviceName: UIDevice.current.name)
    UserDefaults.standard.set(server.absoluteString, forKey: Self.serverKey)
    engine.pause()
    downloads.invalidate()
    let parts = Self.connect(to: server)
    parts.tokens.save(login.token)
    SharedSession.rememberServer(server)
    (serverURL, tokens, api, reporter, engine, snips, downloads) = (server, parts.tokens, parts.api, parts.reporter, parts.engine, parts.snips, parts.downloads)
    listenForDeliveredSnips()
    wireQueue()
    wireLiveActivity()
    signedIn = true
  }

  func signOut() {
    engine.pause()
    liveActivity.end()
    tokens.clear()
    SharedSession.forgetServer()
    signedIn = false
  }

  /// Every feed, followed or not, remembering each show's artwork for `artwork(for:)` and which are unfollowed.
  func feeds() async throws -> [Feed] {
    let feeds = try await api.feeds()
    showArtwork = Dictionary(feeds.compactMap { f in f.imageUrl.map { (f.id, $0) } }, uniquingKeysWith: { a, _ in a })
    unfollowedFeeds = Set(feeds.filter { $0.followed == false }.map(\.id))
    return feeds
  }

  /// An episode's own artwork, else its show's, like the web app's `feedArtwork`.
  func artwork(episodeImage: String?, feedID: ULID) -> String? {
    episodeImage ?? showArtwork[feedID]
  }

  /// Retry waiting reports and snip taps; called when the app comes back to the foreground.
  func flushOutboxes() {
    let (reporter, snips) = (self.reporter, self.snips)
    Task {
      await reporter.flush()
      await snips.flush()
    }
  }

  // MARK: Downloads

  /// How many of Up next's first episodes the phone keeps by itself: 0, 1 or 3.
  static let autoDownloadKey = "downloads.upNext"

  /// Download an episode's recording (its video when video is wanted and it has one). An episode without a recording
  /// yet is fetched on the server first, then downloaded once it is there.
  func downloadEpisode(_ id: ULID, automatic: Bool = false) {
    Task {
      guard var ep = try? await api.episode(id) else { return }
      if ep.asset == nil {
        guard let prepared = try? await api.prepareAudio(id) else { return }
        ep = prepared
        for _ in 0..<40 where ep.asset == nil {
          try? await Task.sleep(for: .seconds(3))
          guard let fresh = try? await api.episode(id) else { return }
          ep = fresh
        }
      }
      guard ep.asset != nil else { return }
      downloads.download(ep, video: engine.wantsVideo, automatic: automatic)
    }
  }

  /// Up next's first few episodes, as the setting says, are kept on the phone; called after Up next is read.
  private func autoDownload() {
    let count = UserDefaults.standard.integer(forKey: Self.autoDownloadKey)
    guard count > 0 else { return }
    for episode in queue.prefix(count) {
      guard let assetID = episode.assetId, downloads.localURL(assetID: assetID, preferVideo: engine.wantsVideo) == nil,
        downloads.state(assetID: assetID, video: true) == nil, downloads.state(assetID: assetID, video: false) == nil
      else { continue }
      downloadEpisode(episode.id, automatic: true)
    }
  }

  // MARK: Queue

  /// Re-read Up next. The episode just left goes first even if its last report hasn't reached the server yet.
  func refreshQueue() async {
    guard let items = try? await api.queue() else { return }
    apply(items)
  }

  private func apply(_ items: [Episode]) {
    var next = items.filter { $0.id != engine.episode?.id }
    if let left = justLeft, let i = next.firstIndex(where: { $0.id == left }) {
      next.insert(next.remove(at: i), at: 0)
    }
    queue = next
    autoDownload()
  }

  /// A drag in Up next: shown at once, then saved as the whole order. A failed save puts back the server's order.
  func moveQueue(from source: IndexSet, to destination: Int) {
    queue.move(fromOffsets: source, toOffset: destination)
    justLeft = nil
    let order = queue.map(\.id)
    Task {
      if let items = try? await api.reorderQueue(order) { apply(items) } else { await refreshQueue() }
    }
  }

  /// Add an episode to the end of Up next.
  func addToQueue(_ episode: Episode) {
    Task {
      if let items = try? await api.addToQueue(episode.id) { apply(items) }
    }
  }

  /// Take an episode out of Up next without marking it played; it comes back if it is played again.
  func removeFromQueue(_ episode: Episode) {
    queue.removeAll { $0.id == episode.id }
    if justLeft == episode.id { justLeft = nil }
    Task {
      if let items = try? await api.removeFromQueue(episode.id) { apply(items) } else { await refreshQueue() }
    }
  }

  /// Play the first episode up next, if any; called when one ends.
  ///
  /// The recording has stopped, so iOS may suspend the app at any moment: background time is asked for until the next
  /// episode is loaded and playing (or 30 s), and Up next as shown is used if the server can't be reached.
  func playNext(after finishedID: ULID? = nil) async {
    let background = UIApplication.shared.beginBackgroundTask(withName: "Up next")
    defer { UIApplication.shared.endBackgroundTask(background) }
    let shown = queue
    await refreshQueue()
    let candidates = queue.isEmpty ? shown : queue
    guard let next = candidates.first(where: { $0.id != finishedID }) else { return }
    engine.open(next.id, autoplay: true)
    for _ in 0..<120 {
      if engine.playing { return }
      if case .error = engine.status { return }
      try? await Task.sleep(for: .milliseconds(250))
    }
  }

  /// Take an episode out of Up next by marking it played (its position is kept).
  func markPlayed(_ episode: Episode) {
    queue.removeAll { $0.id == episode.id }
    guard let assetID = episode.assetId else { return }
    let resume = episode.resume
    Task {
      await reporter.report(
        assetID: assetID, positionMs: resume?.positionMs ?? 0, speed: resume?.speed ?? 1, playing: false, finished: true)
    }
  }

  private func wireQueue() {
    engine.onLeave = { [weak self] id, position, finished in
      guard let self, position > 0, !finished else { return }
      self.justLeft = id
      Task { await self.refreshQueue() }
    }
    engine.onFinished = { [weak self] id in
      guard let self else { return }
      if self.justLeft == id { self.justLeft = nil }
      Task { await self.playNext(after: id) }
    }
    // Headphones' next track (AirPods' double press, or a double tap set to Next Track) snips; see RemoteCommands.
    engine.onNextTrack = { [weak self] in
      guard let self else { return }
      Task { await self.snip() }
    }
  }

  // MARK: Live Activity

  /// The lock screen's and Dynamic Island's activity follows the player's reports, and its buttons act on the player.
  private func wireLiveActivity() {
    let report = engine.onReport
    engine.onReport = { [weak self] id, position, speed, playing, finished in
      report?(id, position, speed, playing, finished)
      guard let self else { return }
      self.liveActivity.update(self.engine)
    }
    PlaybackActivityControl.handler = { [weak self] action in
      guard let self else { return }
      switch action {
      case .toggle: self.engine.toggle()
      case .back: self.engine.skip(by: -15_000)
      case .forward: self.engine.skip(by: 30_000)
      case .snip:
        await self.snip()
      case .skipAd: self.engine.skipAd()
      }
    }
    engine.onAdBreakChange = { [weak self] in
      guard let self else { return }
      self.liveActivity.update(self.engine)
    }
  }

  // MARK: Snips

  /// A tap on Snip: the position and the start of the heard stretch containing it, saved first and sent at once.
  /// The server picks the span, renders the clip and writes the title; the card follows it.
  func snip() async {
    guard let point = engine.snipPoint(), let episodeID = engine.episode?.id else { return }
    sounds.requested()
    liveActivity.show("Snipped at \(Format.clock(point.anchorMs))", engine: engine)
    snipCard?.stop()
    let (pending, snip) = await snips.capture(
      assetID: point.assetID, episodeID: episodeID, anchorMs: point.anchorMs, heardFromMs: point.heardFromMs)
    let card = SnipCardModel(pending: pending, snip: snip)
    snipCard = card
    card.follow(api: api)
  }

  /// Taps cancelled while they were on their way to the server; the snip each becomes is deleted when it arrives.
  private var cancelledTaps: Set<String> = []

  /// The card's X while the moment is still being chosen: the snip is dropped (offline) or deleted, so nothing is
  /// rendered or titled for it. After that the X only closes the card.
  func cancelSnip(_ card: SnipCardModel) {
    card.stop()
    if snipCard === card { snipCard = nil }
    let (api, snips, engine) = (self.api, self.snips, self.engine)
    liveActivity.show("Snip cancelled", engine: engine)
    switch card.phase {
    case .waiting(let pending):
      cancelledTaps.insert(pending.id)
      Task { await snips.cancel(pending.id) }
    case .snip(let snip):
      // The snip count on the player's badge is re-read once the server has the delete.
      Task {
        try? await api.deleteSnip(snip.id)
        await engine.refreshEpisode()
      }
    }
  }


  /// A tap that waited offline reached the server: the card, if it is still showing that tap, follows the snip.
  private func listenForDeliveredSnips() {
    let snips = self.snips
    Task {
      await snips.onEvent { [weak self] event in
        guard case .sent(let pending, let snip) = event else { return }
        Task { @MainActor in
          guard let self else { return }
          if self.cancelledTaps.remove(pending.id) != nil {
            try? await self.api.deleteSnip(snip.id)
            return
          }
          self.sounds.saved()
          guard let card = self.snipCard, case .waiting(let waiting) = card.phase, waiting.id == pending.id
          else { return }
          card.delivered(snip, api: self.api)
        }
      }
    }
  }

  // MARK: Wiring

  private static func connect(to server: URL)
    -> (tokens: TokenStore, api: APIClient, reporter: PlaybackReporter, engine: PlayerEngine, snips: SnipOutbox, downloads: DownloadStore)
  {
    let tokens = TokenStore(server: server)
    let api = APIClient(baseURL: server, token: { tokens.load() }) {
      NotificationCenter.default.post(name: unauthorized, object: nil)
    }
    let outbox = URL.applicationSupportDirectory.appending(path: "playback-outbox.json")
    let reporter = PlaybackReporter(file: outbox) { id, report in _ = try await api.reportPlayback(assetID: id, report) }
    let engine = PlayerEngine(api: api)
    // Downloads are per server: a recording's id means nothing on another.
    let downloads = DownloadStore(root: URL.applicationSupportDirectory.appending(path: "downloads/\(server.host() ?? "server")"), api: api)
    engine.downloads = downloads
    engine.pendingReport = { id in await reporter.pending(assetID: id) }
    engine.onReport = { id, position, speed, playing, finished in
      Task { await reporter.report(assetID: id, positionMs: position, speed: speed, playing: playing, finished: finished) }
    }
    let snips = SnipOutbox(file: URL.applicationSupportDirectory.appending(path: "snip-outbox.json")) { body in
      try await api.createSnip(body)
    }
    return (tokens, api, reporter, engine, snips, downloads)
  }
}
