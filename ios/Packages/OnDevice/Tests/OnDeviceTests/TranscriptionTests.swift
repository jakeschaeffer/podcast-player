import Foundation
import PodcastAPI
import SnipCore
import Testing

@testable import OnDevice

/// Transcription on the phone: the job that downloads a recording and transcribes it, the routes that serve the
/// transcript and its ad breaks, and how the job lives through failures and relaunches. The transcriber, downloader
/// and duration probe are fakes; the feeds are invented.
struct TranscriptionTests {
  /// Tidewater followed, every recording served (4 KiB each), and the newest episode.
  static func tidewater(_ phone: Phone) async throws -> Episode {
    phone.http.serve(Tidewater.url, Tidewater.feed)
    for item in Tidewater.items { phone.downloader.serve(item.url) }
    _ = try await phone.api.createFeed(CreateFeed(url: Tidewater.url))
    return try await phone.api.episodes().items[0]
  }

  static func process(_ phone: Phone, _ episodeId: String) async throws -> (status: Int, detail: EpisodeDetail) {
    var request = URLRequest(url: URL(string: "http://phone.invalid/v1/episodes/\(episodeId)/process")!)
    request.httpMethod = "POST"
    let (data, response) = try await phone.backend.respond(to: request)
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    return ((response as! HTTPURLResponse).statusCode, try decoder.decode(EpisodeDetail.self, from: data))
  }

  // MARK: The job

  @Test func transcribeQueuesThenTranscribesTheFileThatThenPlays() async throws {
    let phone = try Phone()
    let episode = try await Self.tidewater(phone)
    let assetId = try #require(episode.assetId)

    let (status, queued) = try await Self.process(phone, episode.id)
    #expect(status == 202)
    #expect(queued.processing.transcript == .queued)
    #expect(queued.transcriptId == nil)
    #expect(queued.asset?.audioUrl == "https://media.example.com/tidewater/3.mp3?src=feed")
    #expect(try await phone.api.episodes().items[0].processing.transcript == .queued)

    await phone.runJobs()

    // The recording was fetched once, to audio/<asset id>.mp3, and that file was transcribed.
    #expect(phone.downloader.requests.map { $0.url?.absoluteString } == ["https://media.example.com/tidewater/3.mp3?src=feed"])
    #expect(phone.downloader.requests.first?.value(forHTTPHeaderField: "Accept") == "audio/*,*/*")
    let file = phone.folder.appending(path: "audio/\(assetId).mp3")
    #expect(FileManager.default.fileExists(atPath: file.path(percentEncoded: false)))
    #expect(phone.transcriber.calls.map(\.file) == [file])
    #expect(phone.transcriber.calls.map(\.language) == ["en"])

    let detail = try await phone.api.episode(episode.id)
    let transcriptId = try #require(detail.transcriptId)
    #expect(detail.processing.transcript == .ready)
    #expect(detail.processing.audio == .ready && detail.processing.summary == JobState.none && detail.hasSummary == false)
    // What plays is the file that was transcribed, measured.
    let asset = try #require(detail.asset)
    #expect(asset.audioUrl == file.absoluteString)
    #expect(URL(string: asset.audioUrl)?.isFileURL == true)
    #expect(asset.bytes == 4_096)
    #expect(asset.durationMs == 120_000)
    #expect(detail.durationMs == 120_000)
    let listed = try await phone.api.episodes().items[0]
    #expect(listed.transcriptId == transcriptId && listed.processing.transcript == .ready && listed.durationMs == 120_000)
    #expect(try await phone.value("SELECT sha256 AS v FROM audio_asset WHERE id = ?", [.text(assetId)]) != .text(""))

    // The app's own model reads it.
    let transcript = try await phone.api.transcript(transcriptId)
    #expect(transcript.id == transcriptId && transcript.assetId == assetId && transcript.language == "en")
    #expect(transcript.wordCount == 4)
    #expect(transcript.segments.map(\.s) == [1_000] && transcript.segments[0].spk == nil && transcript.segments[0].w0 == 0)
    #expect(transcript.segments[0].words.count == 4)
    #expect(try await phone.api.speakers(transcriptId) == nil)
    #expect(try await phone.value("SELECT provider || '/' || model AS v FROM transcript") == .text("apple/speechtranscriber"))

    // Asking again does nothing more.
    let (again, ready) = try await Self.process(phone, episode.id)
    #expect(again == 202 && ready.processing.transcript == .ready && ready.transcriptId == transcriptId)
    await phone.runJobs()
    #expect(phone.transcriber.calls.count == 1 && phone.downloader.requests.count == 1)
  }

  @Test func askingTwiceWhileQueuedOrRunningIsOneJob() async throws {
    let phone = try Phone()
    let episode = try await Self.tidewater(phone)
    _ = try await Self.process(phone, episode.id)
    let (status, detail) = try await Self.process(phone, episode.id)
    #expect(status == 202 && detail.processing.transcript == .queued)
    #expect(try await phone.value("SELECT COUNT(*) AS v FROM job") == .integer(1))
    // Running: the detail says so, and another ask is answered with the same.
    let running = try await phone.backend.store.claimTranscription()
    #expect(running != nil)
    let (_, during) = try await Self.process(phone, episode.id)
    #expect(during.processing.transcript == .running)
    #expect(try await phone.value("SELECT status AS v FROM job") == .text("running"))
  }

  @Test func unknownIdsAreTheServersNotFounds() async throws {
    let phone = try Phone()
    let episode = await #expect(throws: APIError.self) { try await phone.api.processEpisode("01AAAAAAAAAAAAAAAAAAAAAAAA") }
    #expect(episode == APIError(status: 404, code: "not_found", message: "episode not found"))
    let transcript = await #expect(throws: APIError.self) { try await phone.api.transcript("01AAAAAAAAAAAAAAAAAAAAAAAA") }
    #expect(transcript == APIError(status: 404, code: "not_found", message: "transcript not found"))
    let speakers = await #expect(throws: APIError.self) { try await phone.api.speakers("01AAAAAAAAAAAAAAAAAAAAAAAA") }
    #expect(speakers == APIError(status: 404, code: "not_found", message: "transcript not found"))
  }

  @Test func theFeedsLanguageIsTheOneTranscribed() async throws {
    let phone = try Phone()
    let url = "https://feeds.example.com/marais.xml"
    let item = TestItem(title: "Le Quai", guid: "m-1", url: "https://media.example.com/marais/1.m4a", type: "audio/mp4")
    phone.http.serve(url, rss(title: "Radio Marais", items: [item]).replacingOccurrences(of: "<language>en</language>", with: "<language>fr-CA</language>"))
    phone.downloader.serve(item.url)
    _ = try await phone.api.createFeed(CreateFeed(url: url))
    let episode = try await phone.api.episodes().items[0]
    _ = try await phone.api.processEpisode(episode.id)
    await phone.runJobs()
    #expect(phone.transcriber.calls.map(\.language) == ["fr"])
    #expect(phone.transcriber.calls.first?.file.lastPathComponent == "\(episode.assetId!).m4a")
  }

  // MARK: The transcript's shape

  /// contracts/api/transcripts.get.json is what the server serves; a transcript stored on the phone is served the
  /// same, key for key, and the app's model reads it.
  @Test func aStoredTranscriptIsServedInTheServersShape() async throws {
    let root = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let recording = try JSONSerialization.jsonObject(with: Data(contentsOf: root.appending(path: "contracts/api/transcripts.get.json"))) as! [String: Any]
    let body = recording["body"] as! [String: Any]
    let api = try JSONDecoder().decode(ApiTranscript.self, from: JSONSerialization.data(withJSONObject: body))

    let phone = try Phone()
    let episode = try await Self.tidewater(phone)
    let assetId = try #require(episode.assetId)
    let id = try await phone.backend.store.storeTranscript(assetId: assetId, NormalizedTranscript(api: api, provider: "apple", model: "speechtranscriber"))

    var request = URLRequest(url: URL(string: "http://phone.invalid/v1/transcripts/\(id)")!)
    request.httpMethod = "GET"
    let (data, response) = try await phone.backend.respond(to: request)
    #expect((response as! HTTPURLResponse).statusCode == 200)
    #expect((response as! HTTPURLResponse).value(forHTTPHeaderField: "Cache-Control") == "private, max-age=31536000, immutable")
    var expected = body
    expected["id"] = id
    expected["asset_id"] = assetId
    let served = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    #expect(NSDictionary(dictionary: served).isEqual(to: expected))

    let decoded = try await phone.api.transcript(id)
    #expect(decoded.wordCount == api.wordCount)
    #expect(decoded.segments.map(\.s) == api.segments.map(\.s))
    #expect(decoded.segments.map(\.spk) == api.segments.map(\.spk))
    #expect(decoded.segments.flatMap(\.words).count == api.wordCount)
    #expect(try await phone.api.episode(episode.id).transcriptId == id)
  }

  // MARK: Ad breaks

  static let talkBefore = Array(repeating: "We left the harbour early and the tide was already turning against us.", count: 6).joined(separator: " ")
  static let sponsorRead = """
    This episode is brought to you by Acme Ferries. Acme Ferries runs every hour across the bay, rain or shine, \
    with hot coffee on board and room for your bicycle. Book your crossing today and use code TIDE for twenty \
    percent off your first trip. Acme Ferries, the easy way across. And now back to the show.
    """
  static let talkAfter = Array(repeating: "By noon the fog had lifted and we could see the far shore at last.", count: 4).joined(separator: " ")

  @Test func aSponsorReadIsAnAdBreakAsTheDetectorFindsIt() async throws {
    let phone = try Phone()
    let words = spoken(Self.talkBefore, from: 500) + spoken(Self.sponsorRead, from: 40_000) + spoken(Self.talkAfter, from: 70_000)
    phone.transcriber.answer(words)
    let episode = try await Self.tidewater(phone)
    #expect(try await phone.api.episode(episode.id).adBreaks == [])
    _ = try await phone.api.processEpisode(episode.id)
    await phone.runJobs()

    let detail = try await phone.api.episode(episode.id)
    let expected = detectAds(
      AdInput(
        speech: try normalize(
          RawTranscript(provider: "apple", model: "speechtranscriber", language: "en", words: words), options: NormalizeOptions(durationMs: 120_000)),
        durationMs: 120_000))
    #expect(expected.count == 1)
    let breaks = try #require(detail.adBreaks)
    #expect(breaks.count == 1)
    #expect(breaks.map(\.startMs) == expected.map(\.startMs))
    #expect(breaks.map(\.endMs) == expected.map(\.endMs))
    #expect(breaks.map(\.confidence) == expected.map(\.confidence.rawValue))
    #expect(breaks.map(\.sources) == expected.map { $0.sources.map(\.rawValue) })
    #expect(breaks.map(\.cue) == expected.map(\.cue))
    #expect(breaks.first?.startMs == 40_000)

    // Stored with the detector's version and its inputs, and served from there.
    #expect(try await phone.value("SELECT detector AS v FROM ad_detection") == .text(adDetectorVersion))
    let transcriptId = try #require(detail.transcriptId)
    #expect(try await phone.value("SELECT inputs AS v FROM ad_detection") == .text(#"{"asr":"\#(transcriptId)","publisher":null,"summary":null}"#))
    // A detection from an older detector is worked out again.
    try await phone.sql("UPDATE ad_detection SET detector = 'ads_v0', breaks = '[]'")
    #expect(try await phone.api.episode(episode.id).adBreaks == detail.adBreaks)
    #expect(try await phone.value("SELECT detector AS v FROM ad_detection") == .text(adDetectorVersion))
  }

  // MARK: Playing queues it

  @Test func playingAnUntranscribedEpisodeQueuesIt() async throws {
    let phone = try Phone()
    let episode = try await Self.tidewater(phone)
    let assetId = try #require(episode.assetId)
    func report(_ seq: Int, playing: Bool) async throws {
      _ = try await phone.api.reportPlayback(
        assetID: assetId, PlaybackReport(positionMs: seq * 1_000, speed: 1, playing: playing, finished: false, seq: seq, observedAt: phone.clock.ms))
    }
    try await report(1, playing: false)
    #expect(try await phone.api.episode(episode.id).processing.transcript == JobState.none)
    try await report(2, playing: true)
    #expect(try await phone.api.episode(episode.id).processing.transcript == .queued)
    try await report(3, playing: true)
    #expect(try await phone.value("SELECT COUNT(*) AS v FROM job") == .integer(1))
    #expect(try await phone.value("SELECT priority AS v FROM job") == .integer(Int64(JobPriority.played)))
    await phone.runJobs()
    #expect(try await phone.api.episode(episode.id).processing.transcript == .ready)
    try await report(4, playing: true)
    #expect(try await phone.value("SELECT status AS v FROM job") == .text("done"))
  }

  @Test func theEpisodeAskedForGoesAheadOfTheOnesPlayed() async throws {
    let phone = try Phone()
    _ = try await Self.tidewater(phone)
    let episodes = try await phone.api.episodes().items
    for (i, episode) in episodes.prefix(2).enumerated() {
      _ = try await phone.api.reportPlayback(
        assetID: episode.assetId!, PlaybackReport(positionMs: 1_000, speed: 1, playing: true, finished: false, seq: i + 1, observedAt: phone.clock.ms))
      phone.clock.ms += 1_000
    }
    _ = try await phone.api.processEpisode(episodes[2].id)
    await phone.runJobs()
    #expect(phone.transcriber.calls.map(\.file.lastPathComponent) == [episodes[2], episodes[0], episodes[1]].map { "\($0.assetId!).\($0 == episodes[2] ? "m4a" : "mp3")" })
  }

  // MARK: Failures

  @Test func aFailedTranscriptionSaysSoAndTranscribeTriesAgain() async throws {
    let phone = try Phone()
    phone.transcriber.answer { _, _ in throw TranscriberError("speech recognition does not support the language 'xx'") }
    let episode = try await Self.tidewater(phone)
    _ = try await phone.api.processEpisode(episode.id)
    await phone.runJobs()
    let failed = try await phone.api.episode(episode.id)
    #expect(failed.processing.transcript == .failed && failed.transcriptId == nil)
    #expect(try await phone.value("SELECT last_error AS v FROM job") == .text("speech recognition does not support the language 'xx'"))
    // The download it made is kept, and plays.
    #expect(failed.asset?.audioUrl.hasPrefix("file://") == true)

    // Playing does not queue it again; Try again does, and the file is not fetched twice.
    _ = try await phone.api.reportPlayback(
      assetID: episode.assetId!, PlaybackReport(positionMs: 1_000, speed: 1, playing: true, finished: false, seq: 1, observedAt: phone.clock.ms))
    #expect(try await phone.api.episode(episode.id).processing.transcript == .failed)
    phone.transcriber.answer(spoken("Second time lucky.", from: 0))
    #expect(try await phone.api.processEpisode(episode.id).processing.transcript == .queued)
    await phone.runJobs()
    #expect(try await phone.api.episode(episode.id).processing.transcript == .ready)
    #expect(phone.downloader.requests.count == 1 && phone.transcriber.calls.count == 2)
  }

  @Test func aFailedDownloadLeavesNoFileAndTheStreamPlays() async throws {
    let phone = try Phone()
    let episode = try await Self.tidewater(phone)
    phone.downloader.serve("https://media.example.com/tidewater/3.mp3?src=feed", status: 404)
    _ = try await phone.api.processEpisode(episode.id)
    await phone.runJobs()
    let detail = try await phone.api.episode(episode.id)
    #expect(detail.processing.transcript == .failed)
    #expect(detail.asset?.audioUrl == "https://media.example.com/tidewater/3.mp3?src=feed")
    #expect(try await phone.value("SELECT last_error AS v FROM job") == .text("enclosure returned 404"))
    #expect(try FileManager.default.contentsOfDirectory(atPath: phone.folder.appending(path: "audio").path(percentEncoded: false)).isEmpty)
    #expect(phone.transcriber.calls.isEmpty)

    // Cut short: the length the publisher declared is not what came.
    phone.downloader.serve("https://media.example.com/tidewater/3.mp3?src=feed", bytes: 100, headers: ["Content-Length": "5000"])
    _ = try await phone.api.processEpisode(episode.id)
    await phone.runJobs()
    #expect(try await phone.value("SELECT last_error AS v FROM job") == .text("download truncated: 100 of 5000 bytes"))
    #expect(try await phone.api.episode(episode.id).asset?.bytes == 14_400_000)
  }

  // MARK: The runner

  @Test func theRunnerTranscribesOneAtATimeByItself() async throws {
    let gauge = Gauge()
    let transcriber = FakeTranscriber { _, language in
      await gauge.enter()
      try await Task.sleep(for: .milliseconds(30))
      await gauge.leave()
      return RawTranscript(provider: "apple", model: "speechtranscriber", language: language, words: spoken("One at a time.", from: 0))
    }
    let phone = try Phone(transcriber: transcriber, startsJobs: true)
    _ = try await Self.tidewater(phone)
    let episodes = try await phone.api.episodes().items
    for episode in episodes { _ = try await phone.api.processEpisode(episode.id) }
    try await eventually { try await phone.api.episodes().items.allSatisfy { $0.processing.transcript == .ready } }
    await phone.backend.jobs.idle()
    #expect(await gauge.most == 1)
    #expect(transcriber.calls.count == 3)
  }

  /// The app ended mid-job: the next launch finds the job `running`, queues it again, and runs it to the end,
  /// keeping the file already downloaded. The ended run can no longer write to it.
  @Test func aJobCutShortByTheAppEndingResumesAtTheNextLaunch() async throws {
    let folder = FileManager.default.temporaryDirectory.appending(path: "ondevice-resume-\(UUID().uuidString)")
    let gate = Gate()
    let first = try Phone(
      folder: folder,
      transcriber: FakeTranscriber { _, _ in
        await gate.wait()
        throw TranscriberError("the app was ended")
      }, startsJobs: true)
    let episode = try await Self.tidewater(first)
    _ = try await first.api.processEpisode(episode.id)
    try await eventually { first.transcriber.calls.count == 1 }
    #expect(try await first.api.episode(episode.id).processing.transcript == .running)

    let second = try Phone(folder: folder, clock: first.clock)
    #expect(try await second.api.episode(episode.id).processing.transcript == .queued)
    #expect(try await second.value("SELECT last_error AS v FROM job") == .text("interrupted"))
    await second.runJobs()
    #expect(second.downloader.requests.isEmpty)
    #expect(second.transcriber.calls.map(\.file.lastPathComponent) == ["\(episode.assetId!).mp3"])
    let done = try await second.api.episode(episode.id)
    #expect(done.processing.transcript == .ready && done.transcriptId != nil)

    // The first run gives up now; its job is no longer its own, so nothing changes.
    await gate.open()
    await first.backend.jobs.idle()
    #expect(try await second.api.episode(episode.id) == done)
    #expect(try await second.value("SELECT status AS v FROM job") == .text("done"))
  }

  /// The app leaves the phone's library and comes back while a job runs: a second backend on the same folder in the
  /// same process. It leaves the running job alone and shares the runner, so it is still one job at a time.
  @Test func aSecondBackendInTheSameProcessLeavesTheRunningJobAlone() async throws {
    let folder = FileManager.default.temporaryDirectory.appending(path: "ondevice-twice-\(UUID().uuidString)")
    let host = JobHost()
    let gate = Gate()
    let gauge = Gauge()
    let transcriber = FakeTranscriber { _, language in
      await gauge.enter()
      await gate.wait()
      await gauge.leave()
      return RawTranscript(provider: "apple", model: "speechtranscriber", language: language, words: spoken("Still here.", from: 0))
    }
    let first = try Phone(folder: folder, transcriber: transcriber, host: host, startsJobs: true)
    _ = try await Self.tidewater(first)
    let episodes = try await first.api.episodes().items
    _ = try await first.api.processEpisode(episodes[0].id)
    try await eventually { transcriber.calls.count == 1 }

    let second = try Phone(folder: folder, clock: first.clock, transcriber: transcriber, downloader: first.downloader, host: host, startsJobs: true)
    #expect(try await second.api.episode(episodes[0].id).processing.transcript == .running)
    _ = try await second.api.processEpisode(episodes[1].id)
    try await Task.sleep(for: .milliseconds(50))
    #expect(transcriber.calls.count == 1)
    await gate.open()
    try await eventually { try await second.api.episodes().items.prefix(2).allSatisfy { $0.processing.transcript == .ready } }
    await second.backend.jobs.idle()
    #expect(await gauge.most == 1)
    #expect(transcriber.calls.count == 2)
  }

  @Test func aJobThatKeepsEndingTheAppIsGivenUp() async throws {
    let folder = FileManager.default.temporaryDirectory.appending(path: "ondevice-giveup-\(UUID().uuidString)")
    let first = try Phone(folder: folder)
    let episode = try await Self.tidewater(first)
    _ = try await first.api.processEpisode(episode.id)
    try await first.sql("UPDATE job SET status = 'running', attempts = ?", [.integer(Int64(Store.maxAttempts))])
    let second = try Phone(folder: folder)
    #expect(try await second.api.episode(episode.id).processing.transcript == .failed)
    #expect(try await second.value("SELECT last_error AS v FROM job") == .text("interrupted too many times"))
    // Try again starts it afresh.
    second.downloader.serve("https://media.example.com/tidewater/3.mp3?src=feed")
    _ = try await second.api.processEpisode(episode.id)
    await second.runJobs()
    #expect(try await second.api.episode(episode.id).processing.transcript == .ready)
  }

  @Test func theSchemaHasTheTranscriptTables() async throws {
    let phone = try Phone()
    #expect(
      try await phone.value(
        "SELECT COUNT(*) AS v FROM sqlite_master WHERE type = 'table' AND name IN ('transcript', 'transcript_segment', 'ad_detection', 'job')")
        == .integer(4))
  }
}

/// How many calls are inside at once, and the most there ever were.
actor Gauge {
  private var now = 0
  private(set) var most = 0
  func enter() {
    now += 1
    most = max(most, now)
  }
  func leave() { now -= 1 }
}

/// Holds whoever waits until it is opened.
actor Gate {
  private var isOpen = false
  private var waiting: [CheckedContinuation<Void, Never>] = []

  func wait() async {
    if isOpen { return }
    await withCheckedContinuation { waiting.append($0) }
  }

  func open() {
    isOpen = true
    for continuation in waiting { continuation.resume() }
    waiting = []
  }
}
