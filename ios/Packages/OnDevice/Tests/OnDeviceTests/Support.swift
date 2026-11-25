import Foundation
import PodcastAPI

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

/// A phone: a backend on a fresh folder, and the app's own client talking to it.
struct Phone {
  let folder: URL
  let http: StubHTTP
  let clock: TestClock
  let backend: LocalBackend
  let api: APIClient

  init(folder: URL? = nil, http: StubHTTP = StubHTTP(), clock: TestClock = TestClock(), deviceName: String = "Test Phone") throws {
    self.folder = folder ?? FileManager.default.temporaryDirectory.appending(path: "ondevice-\(UUID().uuidString)")
    self.http = http
    self.clock = clock
    backend = try LocalBackend(folder: self.folder, deviceName: deviceName, http: http, now: { clock.date })
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
