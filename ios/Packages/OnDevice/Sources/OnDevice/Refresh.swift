import Foundation
import PodcastAPI

// The half of server/src/services/feeds.ts and chapters.ts that goes out to the network: fetching a feed's
// document and an episode's chapters file. On the server these run in jobs through `safeFetch`; here they run
// inside the request that asked, through the transport `LocalBackend` was given.

/// Why a refresh did not happen. By the time it is thrown, the reason is already on the feed (`last_error`).
struct RefreshFailure: Error, Equatable {
  let message: String
}

extension LocalBackend {
  static let feedMaxBytes = 20 * 1024 * 1024
  static let chaptersMaxBytes = 1024 * 1024
  /// JSON chapter files fetched per feed refresh (the server's `REFRESH_FETCH_LIMIT`).
  static let refreshChaptersLimit = 5

  /// A GET for a stored address. Credentials in the address go in an `Authorization` header instead, as the
  /// server's `safeFetch` sends them, and URLSession's own cache is kept out of it: the feed's validators are sent
  /// by hand, so a 304 must come from the publisher.
  static func request(_ address: String, accept: String, timeout: TimeInterval) -> URLRequest? {
    guard var components = URLComponents(string: address) else { return nil }
    var authorization: String?
    if !(components.user ?? "").isEmpty || !(components.password ?? "").isEmpty {
      authorization = "Basic " + Data("\(components.user ?? ""):\(components.password ?? "")".utf8).base64EncodedString()
      components.user = nil
      components.password = nil
    }
    guard let url = components.url else { return nil }
    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
    request.setValue(accept, forHTTPHeaderField: "Accept")
    if let authorization { request.setValue(authorization, forHTTPHeaderField: "Authorization") }
    return request
  }

  /// Fetch the feed with its conditional headers, insert episodes not seen before, and fetch a few chapter files
  /// (the server's `refreshFeed` and `fetchFeedDocument`). Anything that goes wrong is noted on the feed and thrown.
  @discardableResult
  func refresh(feedId: String) async throws -> RefreshReport {
    let feed = try await store.feedRow(feedId)
    let unchanged = RefreshReport(feedId: feedId, notModified: true, newEpisodes: 0, skipped: [])
    // Only podcasts are ever added on the phone; a row of another kind has nothing here that can read it.
    guard feed.kind == "podcast" else { return unchanged }
    guard var request = Self.request(feed.url, accept: "application/rss+xml, application/xml, text/xml, */*", timeout: 30) else {
      return try await fail(feedId, "fetch failed: the feed's address is not a URL")
    }
    if let etag = feed.etag { request.setValue(etag, forHTTPHeaderField: "If-None-Match") }
    if let lastModified = feed.lastModified { request.setValue(lastModified, forHTTPHeaderField: "If-Modified-Since") }

    let data: Data
    let response: HTTPURLResponse
    do {
      let (body, answer) = try await http.respond(to: request)
      guard let answer = answer as? HTTPURLResponse else { return try await fail(feedId, "fetch failed: no HTTP response") }
      (data, response) = (body, answer)
    } catch {
      return try await fail(feedId, "fetch failed: \(error.localizedDescription)")
    }
    if response.statusCode == 304 {
      try await store.recordNotModified(feedId)
      return unchanged
    }
    guard response.statusCode == 200 else {
      let status = response.statusCode
      return try await fail(
        feedId,
        status == 401 || status == 403
          ? "credential rejected (401/403); the private feed link may have expired"
          : status == 404 || status == 410 ? "feed not found (\(status))" : "unexpected status \(status)")
    }
    guard data.count <= Self.feedMaxBytes else { return try await fail(feedId, "fetch failed: response exceeded \(Self.feedMaxBytes) bytes") }
    let parsed: ParsedFeed
    do {
      parsed = try FeedParser.parse(data)
    } catch {
      return try await fail(feedId, "parse failed: \(error.localizedDescription)")
    }
    let report = try await store.applyRefresh(
      feedId: feedId, parsed: parsed, etag: response.value(forHTTPHeaderField: "ETag"),
      lastModified: response.value(forHTTPHeaderField: "Last-Modified"))
    // After a refresh the server fetches chapter files for a few episodes that already have their recording;
    // on the phone that is every episode, so this is the newest few that name a file.
    for id in (try? await store.episodesAwaitingChapters(feedId: feedId, limit: Self.refreshChaptersLimit)) ?? [] {
      await fetchFeedChapters(episodeId: id)
    }
    return report
  }

  private func fail(_ feedId: String, _ message: String) async throws -> RefreshReport {
    try await store.recordFeedError(feedId, message)
    throw RefreshFailure(message: message)
  }

  /// Fetch and store the episode's JSON chapters file, if it has one not yet fetched. A file that is missing
  /// (4xx), malformed, or has no usable chapters is recorded as `[]` so it is not asked for again; a server error
  /// or network failure leaves it for the next attempt. Never throws: chapters are a nicety.
  func fetchFeedChapters(episodeId: String) async {
    guard let address = try? await store.pendingChaptersUrl(episodeId: episodeId),
      let request = Self.request(address, accept: "application/json+chapters, application/json;q=0.9, */*;q=0.1", timeout: 20),
      let (data, answer) = try? await http.respond(to: request), let response = answer as? HTTPURLResponse
    else { return }
    if response.statusCode != 200 {
      let status = response.statusCode
      if status >= 400, status < 500, status != 429 { try? await store.storeFeedChapters(episodeId: episodeId, points: nil) }
      return
    }
    let points = data.count <= Self.chaptersMaxBytes ? ChapterPoints.jsonChapters(data) : nil
    try? await store.storeFeedChapters(episodeId: episodeId, points: points)
  }
}
