import AVFoundation
import Foundation
import PlayerKit
import PodcastAPI
import Synchronization
import Testing

@MainActor @Test(.serialized, .timeLimit(.minutes(1)), arguments: [200, 500])
func lateRenewalDoesNotAffectEpisodeFromAnotherShow(renewalStatus: Int) async throws {
  let config = URLSessionConfiguration.ephemeral
  config.protocolClasses = [RenewalRequest.self]
  let session = URLSession(configuration: config)
  defer { session.invalidateAndCancel() }
  let api = APIClient(baseURL: URL(string: "https://renewal.test")!, session: session, token: { nil })
  let engine = PlayerEngine(api: api)
  let (stream, continuation) = AsyncStream<RenewalRequest.Pending>.makeStream()
  RenewalRequest.pending.withLock { $0 = continuation }
  defer { RenewalRequest.pending.withLock { $0 = nil } }
  var requests = stream.makeAsyncIterator()
  let first = UUID().uuidString
  let second = UUID().uuidString
  defer { UserDefaults.standard.removeObject(forKey: "player.speed.show.\(second)") }

  let openFirst = try #require(engine.open(first))
  let initial = try #require(await requests.next()).request
  initial.respond(episode: first, audioURL: "file:///missing-first.mp3?e=1")
  await openFirst.value
  try #require(engine.status == .ready)

  let renewal = try #require(engine.play())
  let late = try #require(await requests.next()).request
  #expect(late.request.url?.lastPathComponent == first)

  let openSecond = try #require(engine.open(second))
  let next = try #require(await requests.next()).request
  next.respond(episode: second, audioURL: "file:///missing-second.mp3")
  await openSecond.value
  try #require(engine.status == .ready)
  engine.setSpeed(1.25)
  let secondItem = try #require(engine.player.currentItem)

  late.respond(episode: first, audioURL: "file:///renewed-first.mp3", status: renewalStatus)
  await renewal.value
  #expect(engine.episode?.id == second)
  #expect(engine.status == .ready)
  #expect(engine.player.currentItem === secondItem)
  #expect(engine.speed == 1.25)
  #expect(!engine.playing)
}

/// Lets the test release API responses in order, without clocks or real media requests.
private final class RenewalRequest: URLProtocol, @unchecked Sendable {
  // Only the test sends responses; URLSession owns and runs the protocol callbacks.
  struct Pending: @unchecked Sendable { let request: RenewalRequest }
  static let pending = Mutex<AsyncStream<Pending>.Continuation?>(nil)

  override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "renewal.test" }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() { Self.pending.withLock { _ = $0?.yield(Pending(request: self)) } }
  override func stopLoading() {}

  func respond(episode id: String, audioURL: String, status: Int = 200) {
    let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
    let body = """
      {"id":"\(id)","feed_id":"\(id)","title":"Test episode","has_summary":false,
       "processing":{"audio":"ready","transcript":"none","text":"none","summary":"none"},
       "media_kind":"audio","video":{"status":"none"},"snip_count":0,
       "asset":{"id":"\(id)","duration_ms":1000,"mime":"audio/mpeg","bytes":1,"audio_url":"\(audioURL)"}}
      """
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
}
