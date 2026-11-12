import AVFoundation
import Foundation
import MediaPlayer
import Observation
import PodcastAPI

/// The player engine, ported from web/src/player/engine.ts (the code is the contract, not 01-playback.md).
///
///   open(episode) → fetch the recording if the server has none yet, then load it at the resume point; the
///                   3 minutes before a resume point count as heard
///   seek / skip   → heard_from = start of the heard stretch containing the new position (HeardTracker)
///   snip()        → (asset_id, anchor_ms: position, heard_from_ms)
///
/// Reports go out every 15 s while playing and at once on pause, seek and speed changes, through `onReport`,
/// which the app wires to SyncKit's PlaybackReporter (it owns `seq` and the offline outbox).
@MainActor @Observable
public final class PlayerEngine {
  public enum Status: Equatable, Sendable { case idle, loading, details, preparing, ready, error(String) }

  public static let speeds: [Double] = [1, 1.25, 1.5, 1.75, 2]
  /// The longest automatic snip (the server's max_ms); audio this far before a resume point counts as heard.
  public static let resumeAssumedHeardMs = 180_000
  static let reportEvery: TimeInterval = 15
  static let preparePoll: Duration = .seconds(2)

  public private(set) var status: Status = .idle
  public private(set) var episode: EpisodeDetail?
  public private(set) var positionMs = 0
  public private(set) var durationMs = 0
  public private(set) var playing = false
  public private(set) var buffering = false
  public private(set) var finished = false
  /// The recording is playing through its video file (it has one, and video is wanted); else through its audio.
  public private(set) var video = false
  /// The recording is playing from a file on the phone (DownloadStore), not a stream.
  public private(set) var offline = false
  /// The episode was opened from what was saved with its download because the server could not be reached, so any
  /// file on the phone is better than a stream that will fail.
  private var openedOffline = false
  /// Files on the phone, when the app keeps any: the player uses one instead of a stream when it has it.
  public var downloads: DownloadStore?
  /// The recording's playback report still waiting in the outbox, if any; offline, it is newer than the resume saved
  /// with the download.
  public var pendingReport: (@Sendable (ULID) async -> PlaybackReport?)?
  public private(set) var heardFromMs = 0
  /// Set when the recording itself fails to load; Play retries with a fresh signed URL.
  public private(set) var loadError: String?
  public private(set) var speed: Double = UserDefaults.standard.object(forKey: "player.speed") as? Double ?? 1

  /// The cover on the lock screen and in Control Center; the app sets it once the image has loaded.
  public var nowPlayingArtwork: MPMediaItemArtwork? {
    didSet { if !quietArtwork { NowPlaying.update(for: self) } }
  }
  private var quietArtwork = false

  private func clearArtworkQuietly() {
    quietArtwork = true
    nowPlayingArtwork = nil
    quietArtwork = false
  }

  public var onReport: ((ULID, _ positionMs: Int, _ speed: Double, _ playing: Bool, _ finished: Bool) -> Void)?
  /// Another episode is being opened in place of `episode` (the app moves the one left to the top of Up Next).
  public var onLeave: ((_ episodeID: ULID, _ positionMs: Int, _ finished: Bool) -> Void)?
  /// The recording played to its end (after the finished report); the app starts the next in the queue.
  public var onFinished: ((_ episodeID: ULID) -> Void)?
  /// Headphones' next track (AirPods' double press): the app snips.
  public var onNextTrack: (() -> Void)?
  /// Playback went into or out of a suspected ad break (the Live Activity shows Skip ad only during one).
  public var onAdBreakChange: (() -> Void)?
  private var lastAdBreak: AdBreak?
  /// An ad break was skipped on its own (`skipsAdsAutomatically`): the app plays its sound.
  public var onAdSkipped: ((AdBreak) -> Void)?
  /// The break skipped on its own a moment ago, while "Undo skip" is offered (`AdSkip.undoSeconds`).
  public private(set) var skippedAd: AdBreak?
  /// A break the listener went into themselves (a seek landed in it): it plays whatever the setting. Only the next
  /// seek changes it, never a tick: one from just before a seek lands still reports the old time, and clearing on it
  /// skipped a break straight after Undo skip.
  private var chosenAdBreak: AdBreak?

  private let api: APIClient
  /// The app's one player. The video surface attaches its layer to it; nothing else should drive it.
  public let player = AVPlayer()
  private var heard = HeardTracker()
  private var timeObserver: Any?
  private var observations: [NSKeyValueObservation] = []
  private var itemStatus: NSKeyValueObservation?
  private var openTask: Task<Void, Never>?
  private var lastReport = Date.distantPast
  private var audioURL: URL?

  public init(api: APIClient) {
    self.api = api
    player.automaticallyWaitsToMinimizeStalling = true
    AudioSessionController.configure()
    RemoteCommands.install(on: self)
    observations.append(
      player.observe(\.timeControlStatus, options: [.new]) { [weak self] p, _ in
        let state = p.timeControlStatus
        MainActor.assumeIsolated { self?.timeControlChanged(state) }
      })
    #if os(iOS)
      // After a call or Siri, pick up again when iOS says to (the interruption's "should resume").
      NotificationCenter.default.addObserver(
        forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
      ) { [weak self] note in
        let info = note.userInfo ?? [:]
        let ended = (info[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init) == .ended
        let options = AVAudioSession.InterruptionOptions(rawValue: info[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
        MainActor.assumeIsolated {
          if ended && options.contains(.shouldResume) { self?.play() }
        }
      }
    #endif
    NotificationCenter.default.addObserver(
      forName: AVPlayerItem.didPlayToEndTimeNotification, object: nil, queue: .main
    ) { [weak self] note in
      let ended = (note.object as? AVPlayerItem).map(ObjectIdentifier.init)
      MainActor.assumeIsolated {
        guard let self, let current = self.player.currentItem, ended == ObjectIdentifier(current) else { return }
        self.finished = true
        self.report(force: true)
        if let assetID = self.assetID { self.downloads?.markFinished(assetID: assetID, finished: true) }
        if let id = self.episode?.id { self.onFinished?(id) }
      }
    }
  }

  public var assetID: ULID? { episode?.asset?.id }

  // MARK: Loading

  /// Load an episode, asking the server to fetch its recording first when it has none, and optionally start it.
  /// Returns the loading work, for a caller that must wait for it (a Live Activity's Play in a relaunched app).
  @discardableResult
  public func open(_ episodeID: ULID, autoplay: Bool = false) -> Task<Void, Never>? {
    if episode?.id == episodeID, status == .ready {
      if autoplay { return play() }
      return nil
    }
    if let left = episode, status == .ready { onLeave?(left.id, positionMs, finished) }
    detach()
    openTask?.cancel()
    skippedAd = nil
    chosenAdBreak = nil
    status = .loading
    // The lock screen keeps the episode being left until the next one is ready: with no Now Playing entry iOS stops
    // sending the app the headphones' buttons, which would strand them if loading is slow or fails.
    episode = nil
    clearArtworkQuietly()
    openTask = Task {
      do {
        var ep: EpisodeDetail
        openedOffline = false
        do {
          ep = try await api.episode(episodeID)
          downloads?.refresh(ep)
        } catch {
          // No connection (or no server): an episode downloaded to the phone opens from what was saved with it, at
          // the position the phone last reported if that is newer.
          guard var saved = downloads?.cachedDetail(episodeID), let asset = saved.asset else { throw error }
          if let report = await pendingReport?(asset.id), report.observedAt > (saved.resume?.updatedAt ?? 0) {
            saved.resume = Resume(positionMs: report.positionMs, speed: report.speed, finished: report.finished, deviceName: nil, updatedAt: report.observedAt)
          }
          ep = saved
          openedOffline = true
        }
        // A channel's video opens on its details: only Fetch (`fetchVideo`) starts the download.
        if ep.isUnfetchedChannelVideo {
          try Task.checkCancellation()
          episode = ep
          status = .details
          return
        }
        if ep.asset == nil {
          ep = try await api.prepareAudio(episodeID)
          status = .preparing
          episode = ep
          while ep.asset == nil {
            if ep.processing.audio == .failed { throw APIError(status: 0, code: "audio", message: "The recording could not be fetched") }
            try await Task.sleep(for: Self.preparePoll)
            ep = try await api.episode(episodeID)
          }
        }
        try Task.checkCancellation()
        attach(ep, autoplay: autoplay)
      } catch is CancellationError {
      } catch {
        status = .error(error.localizedDescription)
      }
    }
    return openTask
  }

  private func attach(_ ep: EpisodeDetail, autoplay: Bool) {
    guard let asset = ep.asset else { return }
    let url: URL
    // Online, a file on the phone stands in for the stream only when it is the kind wanted: asking for the video
    // with only the audio downloaded streams the video. Offline, whatever is on the phone plays.
    let wantVideo = wantsVideo && asset.videoUrl != nil
    let local = openedOffline
      ? downloads?.localURL(assetID: asset.id, preferVideo: wantsVideo)
      : downloads?.localFile(assetID: asset.id, video: wantVideo).map { (url: $0, video: wantVideo) }
    if let local {
      (url, video, offline) = (local.url, local.video, true)
    } else {
      video = wantsVideo && asset.videoUrl != nil
      offline = false
      guard let streamed = SignedURL.onServer(mediaURL(asset), base: api.baseURL) else { return }
      url = streamed
    }
    let start = (ep.resume?.finished ?? true) ? 0 : min(ep.resume?.positionMs ?? 0, asset.durationMs)
    heard.reset(startMs: start, assumeHeardBeforeMs: Self.resumeAssumedHeardMs)
    episode = ep
    durationMs = asset.durationMs
    positionMs = start
    heardFromMs = heard.heardFrom(start)
    finished = false
    status = .ready
    load(url, at: start)
    NowPlaying.update(for: self)
    if autoplay { play() }
  }

  private func load(_ url: URL, at ms: Int) {
    audioURL = url
    // No AVURLAssetPreferPreciseDurationAndTimingKey: on a streamed MP3 it makes AVFoundation read the whole file
    // before the first sample plays (a minute or more for a 60 MB episode on cellular; measured 2026-10-26). The
    // server's duration_ms is the duration; precise timing can come back for downloaded files.
    let item = AVPlayerItem(url: url)
    itemStatus = item.observe(\.status, options: [.new]) { [weak self] item, _ in
      let message = item.status == .failed ? (item.error?.localizedDescription ?? "The recording could not be played") : nil
      MainActor.assumeIsolated { self?.loadError = message }
    }
    loadError = nil
    player.replaceCurrentItem(with: item)
    if ms > 0 { player.seek(to: Self.time(ms), toleranceBefore: .zero, toleranceAfter: .zero) }
    installTimeObserver()
  }

  private func detach() {
    if status == .ready {
      player.pause()
      report(force: true)
    }
    if let timeObserver { player.removeTimeObserver(timeObserver) }
    timeObserver = nil
    player.replaceCurrentItem(with: nil)
  }

  /// Re-read the loaded episode (transcript, processing, snip count) without touching playback.
  public func refreshEpisode() async {
    guard let id = episode?.id, status == .ready || status == .details, let fresh = try? await api.episode(id), episode?.id == id else { return }
    episode = fresh
  }

  /// Fetch, on a channel's video showing its details. The player's poll picks up the video when it arrives.
  public func fetchVideo() async throws {
    guard let id = episode?.id, status == .details else { return }
    let fresh = try await api.requestVideo(id)
    if episode?.id == id { episode = fresh }
  }

  /// Read the episode again and play on from the same spot through whatever its recording now is: its video
  /// arrived, or the owner chose video or sound only.
  public func reload() async {
    // A channel's video that was only being looked at has arrived: now there is something to play.
    if status == .details, let id = episode?.id {
      if let fresh = try? await api.episode(id), episode?.id == id, status == .details, fresh.asset != nil { attach(fresh, autoplay: false) }
      return
    }
    guard let id = episode?.id, status == .ready, let fresh = try? await api.episode(id), episode?.id == id else { return }
    let (at, wasPlaying) = (positionMs, playing)
    detach()
    attach(fresh, autoplay: false)
    seek(to: at, byListener: false)
    if wasPlaying { play() }
  }

  // MARK: Video

  public static let videoKey = "player.video"

  /// Whether a recording with a picture plays as video (the owner's choice, kept) or as sound only.
  public var wantsVideo: Bool { UserDefaults.standard.object(forKey: Self.videoKey) as? Bool ?? true }

  /// Play video or sound only; a loaded recording with a picture switches at its current position.
  public func setWantsVideo(_ on: Bool) {
    UserDefaults.standard.set(on, forKey: Self.videoKey)
    if status == .ready, episode?.asset?.videoUrl != nil, video != on { Task { await reload() } }
  }

  /// The file to play: the video when the recording has one and video is wanted, else the audio.
  private func mediaURL(_ asset: AudioAsset) -> String { video ? (asset.videoUrl ?? asset.audioUrl) : asset.audioUrl }

  // MARK: Transport

  /// Start playing. When the signed URL must be renewed first, playing waits on the returned work, which a caller in
  /// the background (an intent) awaits so that iOS keeps the app up until the audio has started.
  @discardableResult
  public func play() -> Task<Void, Never>? {
    guard status == .ready else { return nil }
    // A signed URL that expired while paused (or failed) is swapped for a fresh one at the same spot.
    if !offline, player.currentItem?.status == .failed || audioURL.map({ SignedURL.needsRenewal($0) }) == true {
      return Task { await renewURL(thenPlay: true) }
    }
    AudioSessionController.activate()
    player.playImmediately(atRate: Float(speed))
    return nil
  }

  public func pause() { player.pause() }

  @discardableResult
  public func toggle() -> Task<Void, Never>? {
    if playing {
      pause()
      return nil
    }
    return play()
  }

  public func seek(to ms: Int) { seek(to: ms, byListener: true) }

  /// A listener's seek (a scrub, a skip, a tap on the words or a chapter, Undo skip) plays any ad break it lands in,
  /// whatever the setting, and ends Undo skip. The engine's own (an ad skipped by itself, a reload back to the same
  /// spot) leave both as they were.
  private func seek(to ms: Int, byListener: Bool) {
    guard status == .ready else { return }
    let to = max(0, min(ms, durationMs > 0 ? durationMs : ms))
    if byListener {
      chosenAdBreak = AdSkip.breakAt(episode?.adBreaks, positionMs: to)
      skippedAd = nil
    }
    heard.jump(fromMs: positionMs, toMs: to)
    positionMs = to
    heardFromMs = heard.heardFrom(to)
    finished = false
    player.seek(to: Self.time(to), toleranceBefore: .zero, toleranceAfter: .zero)
    report(force: true)
    NowPlaying.update(for: self)
  }

  public func skip(by deltaMs: Int) { seek(to: positionMs + deltaMs) }

  public func setSpeed(_ value: Double) {
    speed = value
    UserDefaults.standard.set(value, forKey: "player.speed")
    if playing { player.rate = Float(value) }
    report(force: true)
    NowPlaying.update(for: self)
  }

  public func cycleSpeed() {
    let i = Self.speeds.firstIndex(of: speed) ?? -1
    setSpeed(Self.speeds[(i + 1) % Self.speeds.count])
  }

  /// What a snip tap sends: the position and the start of the heard stretch containing it.
  public func snipPoint() -> (assetID: ULID, anchorMs: Int, heardFromMs: Int)? {
    guard let assetID else { return nil }
    return (assetID, positionMs, heard.heardFrom(positionMs))
  }

  // MARK: Internals

  private func renewURL(thenPlay: Bool) async {
    guard let id = episode?.id else { return }
    do {
      let ep = try await api.episode(id)
      guard let asset = ep.asset else { return }
      video = wantsVideo && asset.videoUrl != nil
      guard let url = SignedURL.onServer(mediaURL(asset), base: api.baseURL) else { return }
      episode = ep
      load(url, at: positionMs)
      if thenPlay {
        AudioSessionController.activate()
        player.playImmediately(atRate: Float(speed))
      }
    } catch {
      status = .error(error.localizedDescription)
    }
  }

  private func installTimeObserver() {
    if let timeObserver { player.removeTimeObserver(timeObserver) }
    // 4 Hz like the web's timeupdate; the transcript view will want 1/30 s off the player's own clock (plan §2.5).
    timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 4), queue: .main) {
      [weak self] time in
      MainActor.assumeIsolated { self?.tick(time) }
    }
  }

  private func tick(_ time: CMTime) {
    guard status == .ready, time.isNumeric else { return }
    let ms = Int((time.seconds * 1000).rounded())
    heard.tick(posMs: ms, playing: playing, speed: speed, wallMs: Int(Date.now.timeIntervalSince1970 * 1000))
    positionMs = ms
    heardFromMs = heard.heardFrom(ms)
    if let item = player.currentItem, item.duration.isNumeric, item.duration.seconds > 0 {
      durationMs = Int(item.duration.seconds * 1000)
    }
    report(force: false)
    // Skipped before the break is announced, so the Live Activity never shows Skip ad for one that is gone at once.
    if let b = AdSkip.automatic(episode?.adBreaks, positionMs: ms, playing: playing, chosen: chosenAdBreak, skipped: skippedAd),
      skipsAdsAutomatically
    {
      skipOnItsOwn(b)
    }
    if currentAdBreak != lastAdBreak {
      lastAdBreak = currentAdBreak
      onAdBreakChange?()
    }
  }

  /// Leave an ad break playback reached, tell the app (its sound), and offer Undo skip for a few seconds.
  private func skipOnItsOwn(_ b: AdBreak) {
    AudioSessionController.log.notice(
      "Skipped the ad break \(b.startMs)–\(b.endMs) ms on its own (\(b.confidence, privacy: .public))")
    seek(to: b.endMs, byListener: false)
    skippedAd = b
    onAdSkipped?(b)
    Task { [weak self] in
      try? await Task.sleep(for: .seconds(AdSkip.undoSeconds))
      if self?.skippedAd == b { self?.skippedAd = nil }
    }
  }

  private func timeControlChanged(_ state: AVPlayer.TimeControlStatus) {
    let wasPlaying = playing
    playing = state != .paused
    buffering = state == .waitingToPlayAtSpecifiedRate
    if wasPlaying != playing {
      report(force: true)
      NowPlaying.update(for: self)
    }
  }

  private func report(force: Bool) {
    guard let assetID, force || Date.now.timeIntervalSince(lastReport) >= Self.reportEvery else { return }
    lastReport = .now
    onReport?(assetID, positionMs, speed, playing, finished)
  }

  static func time(_ ms: Int) -> CMTime { CMTime(value: CMTimeValue(ms), timescale: 1000) }
}
