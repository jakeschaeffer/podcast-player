import Foundation
import Testing

@testable import PodcastAPI

/// The lists a launch draws before the server answers: a list read once can be read again with no request.
@Suite(.serialized) struct SavedResponsesTests {
  final class Stub: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var answer: (status: Int, body: Data)?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
      guard let answer = Self.answer else {
        client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
        return
      }
      let response = HTTPURLResponse(url: request.url!, statusCode: answer.status, httpVersion: nil, headerFields: nil)!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: answer.body)
      client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
  }

  static func client() -> APIClient {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [Stub.self]
    let folder = FileManager.default.temporaryDirectory.appending(path: "saved-\(UUID().uuidString)")
    return APIClient(
      baseURL: URL(string: "http://server.test")!, session: URLSession(configuration: config), token: { "t" },
      saved: SavedResponses(folder: folder))
  }

  static func fixture(_ name: String) throws -> Data {
    let file = try JSONSerialization.jsonObject(
      with: Data(contentsOf: DecodeFixturesTests.fixturesDir.appending(path: "\(name).json")))
    let body = (file as? [String: Any])?["body"] ?? file
    return try JSONSerialization.data(withJSONObject: body, options: .fragmentsAllowed)
  }

  @Test func aListReadOnceIsThereWithNoConnection() async throws {
    let api = Self.client()
    #expect(api.savedEpisodes() == nil)
    Stub.answer = (200, try Self.fixture("episodes.list"))
    let fresh = try await api.episodes(limit: 30).items
    #expect(!fresh.isEmpty)

    Stub.answer = nil
    await #expect(throws: APIError.self) { try await api.episodes(limit: 30) }
    #expect(api.savedEpisodes(limit: 30) == fresh)
    // Another show's page, or a later page, was never the saved one.
    #expect(api.savedSnips() == nil)

    api.saved?.clear()
    #expect(api.savedEpisodes(limit: 30) == nil)
  }

  @Test func anAnswerThatDoesNotDecodeIsNotKept() async throws {
    let api = Self.client()
    Stub.answer = (200, Data("{\"items\": 3}".utf8))
    await #expect(throws: APIError.self) { try await api.queue() }
    #expect(api.savedQueue() == nil)
    Stub.answer = (200, try Self.fixture("queue.list"))
    let queue = try await api.queue()
    #expect(api.savedQueue() == queue)
  }
}
