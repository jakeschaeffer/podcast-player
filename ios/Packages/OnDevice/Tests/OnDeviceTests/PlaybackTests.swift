import Foundation
import PodcastAPI
import Testing

@testable import OnDevice

/// The server's playback cases (server/test/integration.test.ts "keeps playback state per device with a seq guard",
/// server/test/offline-contract.test.ts "device-side times") on the phone, through the app's `APIClient`.
struct PlaybackTests {
  struct Fixture {
    let phone: Phone
    let episodeId: String
    let assetId: String

    init() async throws {
      phone = try Phone()
      phone.http.serve(Tidewater.url, Tidewater.feed)
      _ = try await phone.api.createFeed(CreateFeed(url: Tidewater.url))
      let episode = try await phone.api.episodes().items[0]  // "The Ferry Timetable", 30 minutes by the feed
      episodeId = episode.id
      assetId = episode.assetId!
    }

    func put(seq: Int, _ position: Int, speed: Double = 1.5, playing: Bool = true, finished: Bool = false, observedAt: Int? = nil) async throws -> PlaybackAck {
      try await phone.api.reportPlayback(
        assetID: assetId,
        PlaybackReport(positionMs: position, speed: speed, playing: playing, finished: finished, seq: seq, observedAt: observedAt ?? phone.clock.ms))
    }
  }

  @Test func keepsPlaybackStateWithASeqGuard() async throws {
    let f = try await Fixture()
    let first = try await f.put(seq: 5, 120_000)
    #expect(first.accepted && first.positionMs == 120_000)
    #expect(first.speed == 1.5 && first.playing && !first.finished && first.seq == 5)
    #expect(first.updatedAt == f.phone.clock.ms)
    let stale = try await f.put(seq: 4, 90_000)
    #expect(!stale.accepted && stale.positionMs == 120_000 && stale.seq == 5)
    let replay = try await f.put(seq: 5, 90_000)
    #expect(!replay.accepted && replay.positionMs == 120_000)
    let rewind = try await f.put(seq: 6, 90_000)  // a rewind is respected
    #expect(rewind.accepted && rewind.positionMs == 90_000)
    let resume = try #require(try await f.phone.api.episode(f.episodeId).resume)
    #expect(resume.positionMs == 90_000)
    #expect(resume.deviceName == "Test Phone")
    #expect(resume.speed == 1.5)
    #expect(!resume.finished)
  }

  @Test func ordersResumeByWhenEachPositionWasObservedSoALateReplayDoesNotWin() async throws {
    let f = try await Fixture()
    let t0 = f.phone.clock.ms
    // The tablet listened to 80 s five minutes ago and reported it right away.
    try await f.phone.sql("INSERT INTO device (id, name, platform, token_hash, created_at) VALUES ('01TABLETAAAAAAAAAAAAAAAAAA', 'tablet', 'ios', 'tablet', 0)")
    try await f.phone.sql(
      "INSERT INTO playback_state (device_id, audio_asset_id, position_ms, speed, playing, finished, seq, updated_at, observed_at) VALUES ('01TABLETAAAAAAAAAAAAAAAAAA', ?, 80000, 1, 0, 0, 1, ?, ?)",
      [.text(f.assetId), .integer(Int64(t0)), .integer(Int64(t0 - 300_000))])
    // The phone was offline: its report from ten minutes ago (at 20 s) arrives only now.
    #expect(try await f.put(seq: 1, 20_000, speed: 1, playing: false, observedAt: t0 - 600_000).accepted)
    var resume = try #require(try await f.phone.api.episode(f.episodeId).resume)
    #expect(resume.positionMs == 80_000 && resume.deviceName == "tablet" && resume.updatedAt == t0 - 300_000)

    // A clock running ahead is capped at the time the report was received.
    _ = try await f.put(seq: 2, 30_000, speed: 1, playing: false, observedAt: t0 + 86_400_000)
    resume = try #require(try await f.phone.api.episode(f.episodeId).resume)
    #expect(resume.positionMs == 30_000 && resume.deviceName == "Test Phone" && resume.updatedAt == t0)
  }

  @Test func aFinishedReportIsKeptAndShown() async throws {
    let f = try await Fixture()
    let ack = try await f.put(seq: 1, 1_800_000, playing: false, finished: true)
    #expect(ack.accepted && ack.finished && !ack.playing)
    let episode = try await f.phone.api.episode(f.episodeId)
    #expect(episode.resume?.finished == true)
    #expect(try await f.phone.api.episodes().items[0].resume?.finished == true)
    #expect(try await f.phone.api.queue().isEmpty)
  }

  @Test func refusesAnUnknownRecordingAndAMalformedReport() async throws {
    let f = try await Fixture()
    let report = PlaybackReport(positionMs: 1, speed: 1, playing: true, finished: false, seq: 1, observedAt: 1)
    let unknown = await #expect(throws: APIError.self) { try await f.phone.api.reportPlayback(assetID: "01AAAAAAAAAAAAAAAAAAAAAAAA", report) }
    #expect(unknown == APIError(status: 404, code: "not_found", message: "audio asset not found"))
    func refused(_ body: [String: JSONValue]) async -> APIError? {
      await #expect(throws: APIError.self) { let _: PlaybackAck = try await f.phone.api.send("PUT", "/v1/playback/\(f.assetId)", body: body) }
    }
    let good: [String: JSONValue] = ["position_ms": .number(1000), "speed": .number(1), "playing": .bool(true), "finished": .bool(false), "seq": .number(1)]
    #expect(await refused(good.merging(["speed": .number(9)]) { $1 }) == APIError(status: 400, code: "validation", message: "body/speed must be <= 4"))
    #expect(await refused(good.merging(["position_ms": .number(-1)]) { $1 }) == APIError(status: 400, code: "validation", message: "body/position_ms must be >= 0"))
    #expect(await refused(good.merging(["playing": .string("yes")]) { $1 }) == APIError(status: 400, code: "validation", message: "body/playing must be boolean"))
    #expect(await refused(good.filter { $0.key != "seq" }) == APIError(status: 400, code: "validation", message: "body must have required property 'seq'"))
    // `observed_at` may be left out, as the server allows: the report is then timed by when it arrived.
    let plain: PlaybackAck = try await f.phone.api.send("PUT", "/v1/playback/\(f.assetId)", body: good)
    #expect(plain.accepted)
    #expect(try await f.phone.api.episode(f.episodeId).resume?.updatedAt == f.phone.clock.ms)
  }

  /// Where the phone differs: the server caps a position at the measured length of its own file. The phone has only
  /// the feed's figure, which is missing for some episodes and short of the real file where ads are inserted.
  @Test func aPositionIsNotCappedAtTheLengthTheFeedClaims() async throws {
    let f = try await Fixture()
    #expect(try await f.put(seq: 1, 31 * 60_000).positionMs == 31 * 60_000)  // past the feed's 30 minutes
    let untimed = try await f.phone.api.episodes().items[2]  // "Harbour Lights": the feed gives no length
    let ack = try await f.phone.api.reportPlayback(
      assetID: try #require(untimed.assetId), PlaybackReport(positionMs: 45_000, speed: 1, playing: true, finished: false, seq: 1, observedAt: f.phone.clock.ms))
    #expect(ack.positionMs == 45_000)
    #expect(try await f.phone.api.episode(untimed.id).resume?.positionMs == 45_000)
    #expect(try await f.phone.api.queue().map(\.title) == ["Harbour Lights", "The Ferry Timetable"])
  }

  /// `carryPlace`: a device still playing the recording an episode has moved on from keeps its place on the new one,
  /// when the two are the same cut. Nothing on the phone moves an episode's recording yet, so the second recording
  /// is written by hand.
  @Test func aPlaceFollowsToTheEpisodesCurrentRecordingOfTheSameCut() async throws {
    let f = try await Fixture()
    func recording(_ id: String, durationMs: Int) async throws {
      try await f.phone.sql(
        "INSERT INTO audio_asset (id, episode_id, sha256, bytes, duration_ms, mime, path, created_at) VALUES (?, ?, '', 1, ?, 'audio/mpeg', '', 0)",
        [.text(id), .text(f.episodeId), .integer(Int64(durationMs))])
      try await f.phone.sql("UPDATE episode SET current_asset_id = ? WHERE id = ?", [.text(id), .text(f.episodeId)])
    }
    func place(_ id: String) async throws -> [SQLValue] {
      try await [
        f.phone.value("SELECT position_ms AS v FROM playback_state WHERE audio_asset_id = ?", [.text(id)]),
        f.phone.value("SELECT seq AS v FROM playback_state WHERE audio_asset_id = ?", [.text(id)]),
        f.phone.value("SELECT playing AS v FROM playback_state WHERE audio_asset_id = ?", [.text(id)]),
      ]
    }
    // Half a second longer: the same cut.
    try await recording("01SAMECUTAAAAAAAAAAAAAAAAA", durationMs: 30 * 60_000 + 500)
    #expect(try await f.put(seq: 3, 120_000).accepted)
    #expect(try await place("01SAMECUTAAAAAAAAAAAAAAAAA") == [.integer(120_000), .integer(3), .integer(0)])
    #expect(try await f.phone.api.episode(f.episodeId).resume?.positionMs == 120_000)

    // A report observed earlier than the place already there does not move it back.
    _ = try await f.put(seq: 4, 60_000, observedAt: f.phone.clock.ms - 60_000)
    #expect(try await place("01SAMECUTAAAAAAAAAAAAAAAAA")[0] == .integer(120_000))

    // A recording of another length keeps its own places.
    try await recording("01ANOTHERCUTAAAAAAAAAAAAAA", durationMs: 35 * 60_000)
    f.phone.clock.ms += 1_000
    #expect(try await f.put(seq: 5, 200_000).accepted)
    #expect(try await place("01ANOTHERCUTAAAAAAAAAAAAAA") == [.null, .null, .null])
    #expect(try await f.phone.api.episode(f.episodeId).resume == nil)
  }
}
