import Foundation
import Observation
import PodcastAPI

/// What is on the phone for one recording: its audio or its video file, for playing without a connection, with the
/// episode's details and transcript saved beside it (DownloadStore).
public struct Download: Codable, Sendable, Identifiable, Hashable {
  public var id: String { "\(assetID)-\(video ? "video" : "audio")" }
  public let assetID: ULID
  public let episodeID: ULID
  public let episodeTitle: String
  public let showTitle: String?
  /// The episode's artwork and its show, for the row; nil on a download made before they were kept.
  public var imageUrl: String?
  public var feedID: ULID?
  /// The video file (with its sound), else the audio file.
  public let video: Bool
  /// The file's name in the downloads folder.
  public let file: String
  public var bytes: Int
  public let createdAt: Int
  /// When the episode was finished on this phone; a day later the download goes by itself.
  public var finishedAt: Int?
  /// Set by Up next's automatic downloads, so they can be told from the owner's own.
  public let automatic: Bool
}

/// Where a download stands.
public enum DownloadState: Equatable, Sendable {
  case downloading(progress: Double)
  case done
}

/// The downloads folder, the index of what is in it, and the background session that fills it (docs/video-plan.md).
/// A download holds the recording's file, the episode's details (chapters, ad breaks, resume) and its transcript, so
/// the player, the transcript, the karaoke view and snipping all work with no connection: a snip tap and a playback
/// report wait in their outboxes as they always did. Playing never depends on a download; a download only lets the
/// player use a file on the phone instead of a stream.
@MainActor @Observable
public final class DownloadStore {
  /// Keyed by the app's bundle id, which iOS requires to be unique per app on the phone.
  public static let sessionIdentifier = "\(Bundle.main.bundleIdentifier ?? "Snip").downloads"
  /// The app delegate puts iOS's completion handler here when the app is woken for finished background downloads.
  public nonisolated(unsafe) static var backgroundCompletion: (@Sendable () -> Void)?
  /// A finished episode's download goes this long after it was finished.
  public static let keepFinishedFor: TimeInterval = 24 * 60 * 60

  public private(set) var items: [Download] = []
  public private(set) var progress: [String: Double] = [:]
  public var allowsCellular: Bool {
    didSet { UserDefaults.standard.set(allowsCellular, forKey: Self.cellularKey) }
  }
  public static let cellularKey = "downloads.cellular"

  private let root: URL
  private let api: APIClient
  private var session: URLSession!
  private var delegate: SessionDelegate!
  /// Downloads in flight, by the session task's description (the download id).
  private var inFlight: Set<String> = []

  public init(root: URL, api: APIClient) {
    self.root = root
    self.api = api
    allowsCellular = UserDefaults.standard.bool(forKey: Self.cellularKey)
    for dir in ["", "details", "transcripts"] {
      try? FileManager.default.createDirectory(at: root.appending(path: dir), withIntermediateDirectories: true)
    }
    items = (try? JSONDecoder().decode([Download].self, from: Data(contentsOf: indexURL))) ?? []
    pendingMeta = (try? JSONDecoder().decode([String: Download].self, from: Data(contentsOf: pendingMetaURL))) ?? [:]
    delegate = SessionDelegate(store: self)
    let config = URLSessionConfiguration.background(withIdentifier: Self.sessionIdentifier)
    config.isDiscretionary = false
    config.sessionSendsLaunchEvents = true
    session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
    // Downloads that were running when the app last quit go on; their ids come back with the tasks.
    session.getAllTasks { [weak self] tasks in
      let ids = tasks.compactMap(\.taskDescription)
      Task { @MainActor in self?.inFlight.formUnion(ids) }
    }
    dropFinished()
  }

  private var indexURL: URL { root.appending(path: "index.json") }

  // MARK: Reading

  public func download(assetID: ULID, video: Bool) -> Download? { items.first { $0.assetID == assetID && $0.video == video } }
  public func downloads(episodeID: ULID) -> [Download] { items.filter { $0.episodeID == episodeID } }

  public func state(assetID: ULID, video: Bool) -> DownloadState? {
    let id = "\(assetID)-\(video ? "video" : "audio")"
    if inFlight.contains(id) { return .downloading(progress: progress[id] ?? 0) }
    return download(assetID: assetID, video: video) == nil ? nil : .done
  }

  /// The recording's file of exactly this kind, when it is on the phone.
  public func localFile(assetID: ULID, video: Bool) -> URL? {
    guard let d = download(assetID: assetID, video: video) else { return nil }
    let url = root.appending(path: d.file)
    return FileManager.default.fileExists(atPath: url.path) ? url : nil
  }

  /// A file on the phone for the recording: the wanted kind if it is here, else the other, else nil (for playing
  /// with no connection, where anything on the phone beats nothing).
  public func localURL(assetID: ULID, preferVideo: Bool) -> (url: URL, video: Bool)? {
    for video in preferVideo ? [true, false] : [false, true] {
      if let d = download(assetID: assetID, video: video) {
        let url = root.appending(path: d.file)
        if FileManager.default.fileExists(atPath: url.path) { return (url, video) }
      }
    }
    return nil
  }

  public func cachedDetail(_ episodeID: ULID) -> EpisodeDetail? {
    try? APIClient.decoder.decode(EpisodeDetail.self, from: Data(contentsOf: root.appending(path: "details/\(episodeID).json")))
  }

  public func cachedTranscript(_ id: ULID) -> Transcript? {
    try? APIClient.decoder.decode(Transcript.self, from: Data(contentsOf: root.appending(path: "transcripts/\(id).json")))
  }

  public var totalBytes: Int { items.reduce(0) { $0 + $1.bytes } }

  /// Downloads on their way, as what they will be.
  public var pending: [Download] { inFlight.sorted().compactMap { pendingMeta[$0] } }

  // MARK: Writing

  /// Download the episode's recording (its video when `video` and it has one, else its audio), and save the episode's
  /// details and transcript beside it. Already here, or on its way: nothing happens.
  public func download(_ ep: EpisodeDetail, video wantVideo: Bool, automatic: Bool = false) {
    guard let asset = ep.asset else { return }
    let video = wantVideo && asset.videoUrl != nil
    let id = "\(asset.id)-\(video ? "video" : "audio")"
    guard download(assetID: asset.id, video: video) == nil, !inFlight.contains(id) else { return }
    guard let raw = video ? asset.videoUrl : Optional(asset.audioUrl), let url = SignedURL.onServer(raw, base: api.baseURL) else { return }
    saveDetail(ep)
    if let transcriptID = ep.transcriptId { Task { await self.saveTranscript(transcriptID) } }
    let ext = video ? "mp4" : (asset.mime.contains("mp4") || asset.mime.contains("m4a") ? "m4a" : "mp3")
    // Cellular is decided per download, so the setting applies from the next one without a new session.
    var request = URLRequest(url: url)
    request.allowsCellularAccess = allowsCellular
    let task = session.downloadTask(with: request)
    task.taskDescription = id
    // What the file will be, kept with the task's description so the finished download can be named without the episode.
    pendingMeta[id] = Download(assetID: asset.id, episodeID: ep.id, episodeTitle: ep.title, showTitle: ep.showTitle, imageUrl: ep.imageUrl, feedID: ep.feedId, video: video, file: "\(id).\(ext)", bytes: 0, createdAt: Int(Date().timeIntervalSince1970 * 1000), finishedAt: nil, automatic: automatic)
    savePendingMeta()
    inFlight.insert(id)
    progress[id] = 0
    task.resume()
  }

  /// The episode was read from the server: a download of it keeps the fresh details (resume, transcript) for offline.
  public func refresh(_ ep: EpisodeDetail) {
    guard !downloads(episodeID: ep.id).isEmpty else { return }
    saveDetail(ep)
  }

  /// Take a download off the phone: its file, and the episode's details and transcript once no download of the episode is left.
  public func remove(_ d: Download) {
    try? FileManager.default.removeItem(at: root.appending(path: d.file))
    items.removeAll { $0.id == d.id }
    if downloads(episodeID: d.episodeID).isEmpty {
      if let transcriptID = cachedDetail(d.episodeID)?.transcriptId {
        try? FileManager.default.removeItem(at: root.appending(path: "transcripts/\(transcriptID).json"))
      }
      try? FileManager.default.removeItem(at: root.appending(path: "details/\(d.episodeID).json"))
    }
    saveIndex()
  }

  /// Stop a download on its way.
  public func cancel(assetID: ULID, video: Bool) {
    let id = "\(assetID)-\(video ? "video" : "audio")"
    session.getAllTasks { tasks in tasks.first { $0.taskDescription == id }?.cancel() }
    inFlight.remove(id)
    progress[id] = nil
    pendingMeta[id] = nil
    savePendingMeta()
  }

  /// The episode was finished on this phone: its downloads go in a day (`dropFinished`), unless it is played again.
  public func markFinished(assetID: ULID, finished: Bool) {
    let now = Int(Date().timeIntervalSince1970 * 1000)
    var changed = false
    for i in items.indices where items[i].assetID == assetID {
      let was = items[i].finishedAt
      items[i].finishedAt = finished ? (was ?? now) : nil
      changed = changed || items[i].finishedAt != was
    }
    if changed { saveIndex() }
  }

  /// Downloads of episodes finished more than a day ago go by themselves. Called at launch and when the app returns.
  public func dropFinished() {
    let cutoff = Int((Date().timeIntervalSince1970 - Self.keepFinishedFor) * 1000)
    for d in items where (d.finishedAt ?? .max) < cutoff { remove(d) }
  }

  /// Let go of the background session, cancelling what is on its way, before another store takes its identifier
  /// (signing in builds everything afresh).
  public func invalidate() {
    session.invalidateAndCancel()
  }

  // MARK: Files

  private var pendingMetaURL: URL { root.appending(path: "pending.json") }
  /// What each download on its way will be, by its id, kept on disk so a download finished while the app was gone still gets its name.
  @ObservationIgnored private var pendingMeta: [String: Download] = [:]

  private func saveIndex() {
    try? JSONEncoder().encode(items).write(to: indexURL, options: .atomic)
  }
  private func savePendingMeta() {
    try? JSONEncoder().encode(pendingMeta).write(to: pendingMetaURL, options: .atomic)
  }
  private func saveDetail(_ ep: EpisodeDetail) {
    try? APIClient.encoder.encode(ep).write(to: root.appending(path: "details/\(ep.id).json"), options: .atomic)
  }
  private func saveTranscript(_ id: ULID) async {
    guard let t = try? await api.transcript(id), let data = try? APIClient.encoder.encode(t) else { return }
    try? data.write(to: root.appending(path: "transcripts/\(id).json"), options: .atomic)
  }

  // MARK: The session's news

  fileprivate func finished(id: String, at location: URL) {
    guard var d = pendingMeta[id] else {
      try? FileManager.default.removeItem(at: location)
      return
    }
    let dest = root.appending(path: d.file)
    try? FileManager.default.removeItem(at: dest)
    do {
      try FileManager.default.moveItem(at: location, to: dest)
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      var url = dest
      try? url.setResourceValues(values)
      d.bytes = (try? FileManager.default.attributesOfItem(atPath: dest.path)[.size] as? Int) ?? 0
      items.removeAll { $0.id == d.id }
      items.append(d)
      saveIndex()
    } catch {
      // The file could not be kept; the download is simply not here.
    }
    pendingMeta[id] = nil
    savePendingMeta()
    inFlight.remove(id)
    progress[id] = nil
  }

  fileprivate func failed(id: String) {
    pendingMeta[id] = nil
    savePendingMeta()
    inFlight.remove(id)
    progress[id] = nil
  }

  fileprivate func progressed(id: String, fraction: Double) {
    progress[id] = fraction
  }

  /// The delegate runs on the session's queue; everything it learns is handed to the store on the main actor.
  private final class SessionDelegate: NSObject, URLSessionDownloadDelegate {
    private let store: DownloadStore
    init(store: DownloadStore) { self.store = store }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
      guard let id = downloadTask.taskDescription else { return }
      // The file at `location` is gone once this returns, so it is moved aside first, then handed over.
      let kept = FileManager.default.temporaryDirectory.appending(path: "download-\(UUID().uuidString)")
      try? FileManager.default.moveItem(at: location, to: kept)
      let ok = (downloadTask.response as? HTTPURLResponse).map { (200..<300).contains($0.statusCode) } ?? true
      Task { @MainActor in
        if ok { self.store.finished(id: id, at: kept) } else { try? FileManager.default.removeItem(at: kept); self.store.failed(id: id) }
      }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
      guard let id = downloadTask.taskDescription, totalBytesExpectedToWrite > 0 else { return }
      let fraction = Double(totalBytesWritten) / Double(totalBytesExpectedToWrite)
      Task { @MainActor in self.store.progressed(id: id, fraction: fraction) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
      guard error != nil, let id = task.taskDescription else { return }
      Task { @MainActor in self.store.failed(id: id) }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
      let done = DownloadStore.backgroundCompletion
      DownloadStore.backgroundCompletion = nil
      DispatchQueue.main.async { done?() }
    }
  }
}
