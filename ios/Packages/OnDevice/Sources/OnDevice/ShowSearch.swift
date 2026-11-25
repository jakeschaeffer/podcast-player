import Foundation
import PodcastAPI

// A port of `ItunesShowSearch` (server/src/adapters/showSearch.ts) and of the `GET /v1/search/shows` handler
// (server/src/http/routes/feeds.ts). The server uses Podcast Index instead when it has credentials for it; an app
// cannot keep a secret, so the phone always asks the iTunes Search API, which needs none.

extension LocalBackend {
  static let showSearchName = "itunes"

  /// Shows from the public directory matching `query`, one row per feed address, each marked with the phone's
  /// feed (`feed_id`, `followed`) when the phone already has it. 502 when the directory cannot be reached.
  func searchShows(_ query: String, limit: Int) async throws -> JSON {
    let unavailable = HTTPError(status: 502, code: "upstream", message: "show search is unavailable right now (\(Self.showSearchName))")
    var components = URLComponents(string: "https://itunes.apple.com/search")!
    components.queryItems = [
      URLQueryItem(name: "media", value: "podcast"), URLQueryItem(name: "entity", value: "podcast"),
      URLQueryItem(name: "term", value: query), URLQueryItem(name: "limit", value: String(min(50, limit))),
    ]
    var request = URLRequest(url: components.url!, timeoutInterval: 15)
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    guard let (data, answer) = try? await http.respond(to: request), let response = answer as? HTTPURLResponse,
      (200..<300).contains(response.statusCode), let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
      Self.log.error("show search failed")
      throw unavailable
    }

    let subscribed = try await store.feedsByHash()
    // Directories list some shows twice (a re-uploaded feed, a regional copy); one row per feed URL.
    var seen = Set<String>()
    var results: [JSON] = []
    for raw in body["results"] as? [[String: Any]] ?? [] {
      guard let feedUrl = raw["feedUrl"] as? String, !feedUrl.isEmpty else { continue }
      // The same normalization adding a feed applies before hashing, so a result matches its subscription.
      let key = FeedURL.normalizedString(feedUrl)
      guard seen.insert(key).inserted else { continue }
      let feed = subscribed[FeedURL.hash(key)]
      results.append([
        "title": .string(raw["collectionName"] as? String ?? "(untitled)"),
        "author": JSON(raw["artistName"] as? String),
        "feed_url": .string(feedUrl),
        "artwork_url": JSON(raw["artworkUrl600"] as? String ?? raw["artworkUrl100"] as? String),
        "site_url": JSON(raw["collectionViewUrl"] as? String),
        "episode_count": JSON(raw["trackCount"] as? Int),
        "genres": .array((raw["genres"] as? [String] ?? []).filter { $0 != "Podcasts" }.map(JSON.string)),
        "source": "itunes",
        "feed_id": JSON(feed?.id),
        "followed": feed.map { JSON.bool($0.followed) } ?? .null,
      ])
    }
    return ["source": .string(Self.showSearchName), "results": .array(results)]
  }
}
