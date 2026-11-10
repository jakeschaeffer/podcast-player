import Foundation

/// The server's error envelope, `{ "error": { "code", "message" } }`, or a request that never reached it.
public struct APIError: Error, Sendable, Equatable, LocalizedError {
  /// 0 means the request never reached the server (offline, tunnel down).
  public let status: Int
  public let code: String
  public let message: String
  /// On a 409 from `POST /v1/feeds`: the feed that already has that URL.
  public let feedId: ULID?

  public init(status: Int, code: String, message: String, feedId: ULID? = nil) {
    self.status = status
    self.code = code
    self.message = message
    self.feedId = feedId
  }

  public var isNetwork: Bool { status == 0 }
  public var isUnauthorized: Bool { status == 401 }
  public var errorDescription: String? { isNetwork ? "No connection" : message }

  struct Envelope: Decodable {
    struct Body: Decodable {
      let code: String
      let message: String
      let feedId: ULID?
    }
    let error: Body
  }
}

/// A thin client over the server's JSON API. Sends the device token as a Bearer header; any 401 except at login
/// calls `onUnauthorized`, which signs the app out.
public final class APIClient: Sendable {
  public let baseURL: URL
  private let session: URLSession
  private let token: @Sendable () -> String?
  private let onUnauthorized: @Sendable () -> Void
  /// Where the last answer to each remembered GET is kept (`send(remember:)`, `lastSeen`); nil keeps nothing.
  public let saved: SavedResponses?

  public static let decoder: JSONDecoder = {
    let d = JSONDecoder()
    d.keyDecodingStrategy = .convertFromSnakeCase
    return d
  }()

  public static let encoder: JSONEncoder = {
    let e = JSONEncoder()
    e.keyEncodingStrategy = .convertToSnakeCase
    return e
  }()

  public init(
    baseURL: URL,
    session: URLSession = .shared,
    token: @escaping @Sendable () -> String?,
    saved: SavedResponses? = nil,
    onUnauthorized: @escaping @Sendable () -> Void = {}
  ) {
    self.saved = saved
    self.baseURL = baseURL
    self.session = session
    self.token = token
    self.onUnauthorized = onUnauthorized
  }

  public func send<T: Decodable>(
    _ method: String,
    _ path: String,
    query: [URLQueryItem] = [],
    body: (some Encodable)? = Optional<Empty>.none,
    remember: Bool = false,
    as type: T.Type = T.self
  ) async throws -> T {
    let (data, _) = try await raw(method, path, query: query, body: body)
    do {
      let value = try Self.decoder.decode(T.self, from: data)
      // Only an answer that decoded is worth showing again at the next launch.
      if remember { saved?.write(data, for: SavedResponses.key(path, query)) }
      return value
    } catch {
      throw APIError(status: 200, code: "decode", message: "Unexpected response from the server: \(error)")
    }
  }

  /// The last answer a remembered GET got, on this launch or an earlier one, read from the phone with no request:
  /// what a screen draws at once while it asks again. Nil when there is none, or when it no longer decodes (the
  /// models changed in an update).
  public func lastSeen<T: Decodable>(_ path: String, query: [URLQueryItem] = [], as type: T.Type = T.self) -> T? {
    guard let data = saved?.read(SavedResponses.key(path, query)) else { return nil }
    return try? Self.decoder.decode(T.self, from: data)
  }

  /// For routes whose response the app ignores (DELETE returns 204).
  public func sendIgnoringBody(_ method: String, _ path: String, body: (some Encodable)? = Optional<Empty>.none)
    async throws
  {
    _ = try await raw(method, path, query: [], body: body)
  }

  /// A GET that sends `If-None-Match`: nil when the server answers 304 (nothing changed), else the new value and
  /// its ETag.
  public func getIfChanged<T: Decodable>(_ path: String, etag: String?, as type: T.Type = T.self) async throws
    -> (value: T, etag: String?)?
  {
    let (data, response) = try await raw(
      "GET", path, query: [], body: Optional<Empty>.none, headers: etag.map { ["If-None-Match": $0] } ?? [:])
    if response.statusCode == 304 { return nil }
    do {
      return (try Self.decoder.decode(T.self, from: data), response.value(forHTTPHeaderField: "ETag"))
    } catch {
      throw APIError(status: 200, code: "decode", message: "Unexpected response from the server: \(error)")
    }
  }

  private func raw(
    _ method: String, _ path: String, query: [URLQueryItem], body: (some Encodable)?, headers: [String: String] = [:]
  ) async throws -> (Data, HTTPURLResponse) {
    var components = URLComponents(url: baseURL.appending(path: path), resolvingAgainstBaseURL: false)!
    if !query.isEmpty { components.queryItems = query }
    var request = URLRequest(url: components.url!)
    request.httpMethod = method
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if let token = token() { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
    if !headers.isEmpty { request.cachePolicy = .reloadIgnoringLocalCacheData }
    if let body {
      request.httpBody = try Self.encoder.encode(body)
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }

    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(for: request)
    } catch {
      throw APIError(status: 0, code: "network", message: error.localizedDescription)
    }
    guard let http = response as? HTTPURLResponse else {
      throw APIError(status: 0, code: "network", message: "No HTTP response")
    }
    let status = http.statusCode
    guard (200..<300).contains(status) || status == 304 else {
      let isLogin = method == "POST" && path == "/v1/devices"
      if status == 401 && !isLogin { onUnauthorized() }
      if let envelope = try? Self.decoder.decode(APIError.Envelope.self, from: data) {
        throw APIError(
          status: status, code: envelope.error.code, message: envelope.error.message, feedId: envelope.error.feedId)
      }
      // Anything else (an HTML login page from Cloudflare Access, a proxy error) is not the API talking.
      throw APIError(status: status, code: "request", message: "HTTP \(status) from \(baseURL.host() ?? "server")")
    }
    return (data, http)
  }
}

public struct Empty: Codable, Sendable {}
