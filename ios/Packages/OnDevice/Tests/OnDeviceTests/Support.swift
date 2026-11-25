import Foundation
import PodcastAPI
import SnipCore
import Testing

@testable import OnDevice

/// What the backend fetches through in tests: invented feeds served from memory. A request for an address that
/// was never set up fails like a dead network, so no test can reach the real one.
final class StubHTTP: HTTPTransport, @unchecked Sendable {
  struct Reply {
    var status = 200
    var body = Data()
    var headers: [String: String] = [:]
  }

  private let lock = NSLock()
  private var handlers: [String: @Sendable (URLRequest) -> Reply?] = [:]
  private var log: [URLRequest] = []

  /// Every request made, in order.
  var requests: [URLRequest] { lock.withLock { log } }

  func requests(to address: String) -> [URLRequest] { requests.filter { $0.url?.absoluteString == address } }

  func serve(_ address: String, status: Int = 200, _ body: String = "", headers: [String: String] = [:]) {
    on(address) { _ in Reply(status: status, body: Data(body.utf8), headers: headers) }
  }

  /// Answer `address` with whatever `handler` returns; nil fails the request.
  func on(_ address: String, _ handler: @escaping @Sendable (URLRequest) -> Reply?) {
    lock.withLock { handlers[address] = handler }
  }

  func respond(to request: URLRequest) async throws -> (Data, URLResponse) {
    let handler = lock.withLock {
      log.append(request)
      return handlers[request.url?.absoluteString ?? ""]
    }
    guard let reply = handler?(request) else { throw URLError(.notConnectedToInternet) }
    let response = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers)!
    return (reply.body, response)
  }
}

/// A clock the test moves by hand, in Unix ms like every stored time.
final class TestClock: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Int

  init(_ ms: Int = 1_800_000_000_000) { value = ms }

  var ms: Int {
    get { lock.withLock { value } }
    set { lock.withLock { value = newValue } }
  }

  var date: Date { Date(timeIntervalSince1970: Double(ms) / 1000) }
}

/// A phone: a backend on a fresh folder, and the app's own client talking to it. Its transcriber, downloader and
/// duration probe are fakes, so nothing is fetched or heard. Its jobs wait to be run by hand (`runJobs`) unless
/// `startsJobs`, so a test that plays an episode (which queues it) sees `queued`, not a race. Each phone is its own
/// process (`host`) unless one is shared, so a second phone on the same folder stands for a relaunch.
struct Phone {
  let folder: URL
  let http: StubHTTP
  let clock: TestClock
  let transcriber: FakeTranscriber
  let downloader: StubDownloader
  let durations: StubDurations
  let backend: LocalBackend
  let api: APIClient

  init(
    folder: URL? = nil, http: StubHTTP = StubHTTP(), clock: TestClock = TestClock(), deviceName: String = "Test Phone",
    transcriber: FakeTranscriber = FakeTranscriber(), downloader: StubDownloader = StubDownloader(),
    durations: StubDurations = StubDurations(), host: JobHost = JobHost(), startsJobs: Bool = false
  ) throws {
    self.folder = folder ?? FileManager.default.temporaryDirectory.appending(path: "ondevice-\(UUID().uuidString)")
    self.http = http
    self.clock = clock
    self.transcriber = transcriber
    self.downloader = downloader
    self.durations = durations
    backend = try LocalBackend(
      folder: self.folder, deviceName: deviceName, http: http, now: { clock.date }, transcriber: transcriber, downloader: downloader,
      durations: durations, host: host, startsJobs: startsJobs)
    // The base URL only has to be a URL: nothing is sent to it.
    api = APIClient(baseURL: URL(string: "http://phone.invalid")!, transport: backend, token: { nil })
  }

  /// A statement run straight on the database, for states the routes cannot reach (a second device's reports).
  func sql(_ statement: String, _ args: [SQLValue] = []) async throws {
    try await backend.store.testRun(statement, args)
  }

  func value(_ statement: String, _ args: [SQLValue] = []) async throws -> SQLValue {
    try await backend.store.testValue(statement, args)
  }

  /// Run every queued job to the end, in this task.
  func runJobs() async { await backend.drainJobs() }
}

/// A transcriber that hears what the test says it does. Each call is logged; `handler` can wait, throw, or answer.
final class FakeTranscriber: Transcriber, @unchecked Sendable {
  let name = "apple"
  let model = "speechtranscriber"
  private let lock = NSLock()
  private var log: [(file: URL, language: String?)] = []
  private var handler: @Sendable (URL, String?) async throws -> RawTranscript

  init(_ handler: @escaping @Sendable (URL, String?) async throws -> RawTranscript = { _, language in
    RawTranscript(provider: "apple", model: "speechtranscriber", language: language, words: spoken("Hello from the harbour.", from: 1_000))
  }) {
    self.handler = handler
  }

  var calls: [(file: URL, language: String?)] { lock.withLock { log } }

  func answer(_ handler: @escaping @Sendable (URL, String?) async throws -> RawTranscript) { lock.withLock { self.handler = handler } }

  func answer(_ words: [RawWord]) {
    answer { _, language in RawTranscript(provider: "apple", model: "speechtranscriber", language: language, words: words) }
  }

  func transcribe(file: URL, language: String?) async throws -> RawTranscript {
    let handler = lock.withLock {
      log.append((file, language))
      return self.handler
    }
    return try await handler(file, language)
  }
}

/// Recordings served from memory, written to the file asked for. An address never set up fails like a dead network.
final class StubDownloader: Downloader, @unchecked Sendable {
  struct Reply {
    var status = 200
    var body = Data()
    var headers: [String: String] = [:]
  }

  private let lock = NSLock()
  private var replies: [String: Reply] = [:]
  private var log: [URLRequest] = []

  var requests: [URLRequest] { lock.withLock { log } }

  func serve(_ address: String, status: Int = 200, bytes: Int = 4_096, headers: [String: String] = [:]) {
    lock.withLock { replies[address] = Reply(status: status, body: Data(repeating: 0x55, count: bytes), headers: headers) }
  }

  func download(_ request: URLRequest, to file: URL) async throws -> HTTPURLResponse {
    let reply = lock.withLock {
      log.append(request)
      return replies[request.url?.absoluteString ?? ""]
    }
    guard let reply else { throw URLError(.notConnectedToInternet) }
    try reply.body.write(to: file)
    return HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers)!
  }
}

/// Every downloaded file is this long.
final class StubDurations: DurationProbe, @unchecked Sendable {
  private let lock = NSLock()
  private var value: Int

  init(_ ms: Int = 120_000) { value = ms }

  var ms: Int {
    get { lock.withLock { value } }
    set { lock.withLock { value = newValue } }
  }

  func durationMs(of file: URL) async throws -> Int { ms }
}

/// Words spoken one after another, `wordMs` apart, from `startMs`: an invented script, as a recognizer would time it.
func spoken(_ script: String, from startMs: Double, wordMs: Double = 400) -> [RawWord] {
  script.split(separator: " ").enumerated().map { i, word in
    RawWord(text: String(word), startMs: startMs + Double(i) * wordMs, endMs: startMs + Double(i) * wordMs + wordMs - 60)
  }
}

/// Wait for `condition`, a few seconds at most.
func eventually(_ condition: () async throws -> Bool) async throws {
  for _ in 0..<400 {
    if try await condition() { return }
    try await Task.sleep(for: .milliseconds(10))
  }
  Issue.record("timed out waiting")
}

extension Store {
  func testRun(_ statement: String, _ args: [SQLValue]) throws { try db.run(statement, args) }

  func testValue(_ statement: String, _ args: [SQLValue]) throws -> SQLValue {
    try db.get(statement, args)?.value("v") ?? .null
  }
}

/// An invented episode for an invented feed.
struct TestItem {
  var title: String
  var guid: String?
  var pubDate: String? = nil
  var duration: String? = nil
  var url: String
  var type = "audio/mpeg"
  var length: Int? = nil
  var description: String? = nil
  var extra = ""

  var xml: String {
    var out = "<item><title>\(title)</title>"
    if let guid { out += "<guid isPermaLink=\"false\">\(guid)</guid>" }
    if let pubDate { out += "<pubDate>\(pubDate)</pubDate>" }
    if let duration { out += "<itunes:duration>\(duration)</itunes:duration>" }
    if let description { out += "<description><![CDATA[\(description)]]></description>" }
    out += "<enclosure url=\"\(url)\" type=\"\(type)\"\(length.map { " length=\"\($0)\"" } ?? "")/>"
    return out + extra + "</item>"
  }
}

func rss(title: String, author: String? = nil, items: [TestItem]) -> String {
  """
  <?xml version="1.0" encoding="UTF-8"?>
  <rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:podcast="https://podcastindex.org/namespace/1.0" xmlns:psc="http://podlove.org/simple-chapters">
  <channel>
    <title>\(title)</title>
    <link>https://example.com/\(title.lowercased().replacingOccurrences(of: " ", with: "-"))</link>
    <language>en</language>
    \(author.map { "<itunes:author>\($0)</itunes:author>" } ?? "")
    \(items.map(\.xml).joined(separator: "\n"))
  </channel>
  </rss>
  """
}

/// A made-up show with three episodes, the newest first, as feeds list them.
enum Tidewater {
  static let url = "https://feeds.example.com/tidewater.xml"
  static let items = [
    TestItem(
      title: "The Ferry Timetable", guid: "tw-3", pubDate: "Wed, 21 Oct 2026 10:00:00 GMT", duration: "30:00",
      url: "https://media.example.com/tidewater/3.mp3?src=feed", length: 14_400_000,
      description: "<p>Notes with <script>alert(1)</script><a href=\"https://example.com/ferry\" onclick=\"x()\">a link</a></p>"),
    TestItem(title: "Low Water", guid: "tw-2", pubDate: "Wed, 14 Oct 2026 10:00:00 GMT", duration: "1:02:03", url: "https://media.example.com/tidewater/2.mp3"),
    TestItem(title: "Harbour Lights", guid: "tw-1", pubDate: "Wed, 07 Oct 2026 10:00:00 GMT", url: "https://media.example.com/tidewater/1.m4a", type: "audio/x-m4a"),
  ]
  static let feed = rss(title: "Tidewater Almanac", author: "Example Studio", items: items)
}

func ms(_ iso: String) -> Int {
  Int((ISO8601DateFormatter().date(from: iso)!.timeIntervalSince1970 * 1000).rounded())
}
