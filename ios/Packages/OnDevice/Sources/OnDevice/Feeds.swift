import CryptoKit
import Foundation

// A port of server/src/services/feeds.ts. What the phone leaves out is said where it is left out; the rest is the
// server's rules and SQL.

/// A feed row as stored.
struct FeedRow: Sendable {
  let id: String
  let url: String
  let isPrivate: Bool
  let title: String?
  let author: String?
  let imageUrl: String?
  let siteUrl: String?
  let language: String?
  let autoProcess: Bool
  let transcriber: String
  let keyterms: String
  let etag: String?
  let lastModified: String?
  let lastRefreshAt: Int?
  let lastError: String?
  let createdAt: Int
  let kind: String
  let textForFeedId: String?
  let backfill: Int
  let followed: Bool

  init(_ row: Row) {
    id = row.string("id") ?? ""
    url = row.string("url_enc") ?? ""
    isPrivate = row.bool("is_private")
    title = row.string("title")
    author = row.string("author")
    imageUrl = row.string("image_url")
    siteUrl = row.string("site_url")
    language = row.string("language")
    autoProcess = row.bool("auto_process")
    transcriber = row.string("transcriber") ?? "elevenlabs"
    keyterms = row.string("keyterms") ?? "[]"
    etag = row.string("etag")
    lastModified = row.string("last_modified")
    lastRefreshAt = row.int("last_refresh_at")
    lastError = row.string("last_error")
    createdAt = row.int("created_at") ?? 0
    kind = row.string("kind") ?? "podcast"
    textForFeedId = row.string("text_for_feed_id")
    backfill = row.int("backfill") ?? 0
    followed = row.bool("followed")
  }
}

/// The body of `POST /v1/feeds` (`AddFeedBody` in server/src/http/schemas.ts).
struct AddFeedInput: Sendable {
  var url: String
  var kind: String?
  var textForFeedId: String?
  var isPrivate: Bool?
  var autoProcess: Bool?
  var keyterms: [String]?
  var backfill: Int?
  var followed: Bool?
}

/// The body of `PATCH /v1/feeds/{id}` (`UpdateFeedBody`).
struct UpdateFeedInput: Sendable {
  var title: String?
  var isPrivate: Bool?
  var autoProcess: Bool?
  var transcriber: String?
  var keyterms: [String]?
  var backfill: Int?
  var followed: Bool?
}

struct RefreshReport: Sendable, Equatable {
  var feedId: String
  var notModified: Bool
  var newEpisodes: Int
  var skipped: [SkippedItem]
}

enum FeedURL {
  /// A feed address as the server keeps it: JavaScript's `new URL(text).toString()`, which lower-cases the scheme
  /// and host, drops a default port and gives an empty path a `/`. Two spellings of one address are then one feed.
  /// Throws the server's two 400s.
  static func normalize(_ text: String) throws -> URLComponents {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard var url = URLComponents(string: trimmed), let scheme = url.scheme?.lowercased() else {
      throw HTTPError.badRequest("url is not a valid URL")
    }
    guard scheme == "http" || scheme == "https" else { throw HTTPError.badRequest("url must be http or https") }
    guard let host = url.host, !host.isEmpty else { throw HTTPError.badRequest("url is not a valid URL") }
    url.scheme = scheme
    url.host = host.lowercased()
    if (scheme == "http" && url.port == 80) || (scheme == "https" && url.port == 443) { url.port = nil }
    if url.percentEncodedPath.isEmpty { url.percentEncodedPath = "/" }
    return url
  }

  /// The normalized address, or the text itself when it is not an address (search results are matched this way).
  static func normalizedString(_ text: String) -> String {
    (try? normalize(text))?.string ?? text
  }

  static func hash(_ normalized: String) -> String {
    SHA256.hash(data: Data(normalized.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  /// Credentials in the URL, a query string, or a long mixed-case token as a path segment all mean "private".
  static func looksPrivate(_ url: URLComponents) -> Bool {
    if !(url.user ?? "").isEmpty || !(url.password ?? "").isEmpty || !(url.percentEncodedQuery ?? "").isEmpty { return true }
    return url.percentEncodedPath.split(separator: "/").contains { segment in
      segment.range(of: #"^[A-Za-z0-9_-]{16,}$"#, options: .regularExpression) != nil
        && segment.range(of: "[A-Z]", options: .regularExpression) != nil
        && segment.range(of: "[a-z0-9]", options: .regularExpression) != nil
    }
  }

  /// YouTube in any of the forms the server takes for a channel (its feed, `/@handle`, `/channel/UC…`) or a video.
  static func isYouTube(_ url: URLComponents) -> Bool {
    let host = url.host ?? ""
    return host == "youtu.be" || host.range(of: #"(^|\.)youtube\.com$"#, options: .regularExpression) != nil
  }
}

extension Store {
  func feedView(_ row: FeedRow) throws -> JSON {
    let count = try db.get("SELECT COUNT(*) AS n FROM episode WHERE feed_id = ?", [row.id])?.int("n") ?? 0
    let keyterms = (try? JSONSerialization.jsonObject(with: Data(row.keyterms.utf8)) as? [String]) ?? []
    return [
      "id": .string(row.id),
      "kind": .string(row.kind),
      "text_for_feed_id": JSON(row.textForFeedId),
      "title": JSON(row.title),
      "author": JSON(row.author),
      "image_url": JSON(row.imageUrl),
      "site_url": JSON(row.siteUrl),
      "language": JSON(row.language),
      "is_private": .bool(row.isPrivate),
      "auto_process": .bool(row.autoProcess),
      "transcriber": .string(row.transcriber),
      "keyterms": .array(keyterms.map(JSON.string)),
      "backfill": .int(row.backfill),
      "last_refresh_at": JSON(row.lastRefreshAt),
      "last_error": JSON(row.lastError),
      "episode_count": .int(count),
      "created_at": .int(row.createdAt),
      "followed": .bool(row.followed),
      // A channel's older videos; the phone has no channels, so always the server's resting state.
      "more_videos": ["status": "idle", "error": nil],
    ]
  }

  func feedRow(_ id: String) throws -> FeedRow {
    guard let row = try db.get("SELECT * FROM feed WHERE id = ?", [id]) else { throw HTTPError.notFound("feed") }
    return FeedRow(row)
  }

  func feed(_ id: String) throws -> JSON { try feedView(feedRow(id)) }

  /// Insert the feed row. The server queues its first refresh as a job; `LocalBackend` runs it before answering.
  ///
  /// The phone differs: YouTube channels and text feeds are refused (400), since nothing here can fetch a video or
  /// align an article. `auto_process`, `backfill`, `keyterms` and `transcriber` are stored and returned by the
  /// server's rules, and nothing acts on them: there is no transcription on the phone to start.
  func addFeed(_ input: AddFeedInput) throws -> FeedRow {
    let url = try FeedURL.normalize(input.url)
    guard let normalized = url.string else { throw HTTPError.badRequest("url is not a valid URL") }
    let hash = FeedURL.hash(normalized)
    if let existing = try db.get("SELECT id FROM feed WHERE url_hash = ?", [hash])?.string("id") {
      throw HTTPError.conflict("feed already added", extra: ["feed_id": existing])
    }
    if input.kind == "youtube" || FeedURL.isYouTube(url) { throw HTTPError.badRequest("YouTube channels are not available on this phone") }
    if input.kind == "text" || input.textForFeedId != nil { throw HTTPError.badRequest("text feeds are not available on this phone") }
    let isPrivate = input.isPrivate ?? FeedURL.looksPrivate(url)
    // A show opened without following is always manual: browsing one must never bill.
    let followed = input.followed != false
    let autoProcess = followed && input.autoProcess != false
    let backfill = followed ? (input.backfill ?? 2) : 0
    let id = newId()
    let keyterms = String(decoding: JSON.array((input.keyterms ?? []).map(JSON.string)).data(), as: UTF8.self)
    try db.run(
      "INSERT INTO feed (id, url_enc, url_hash, is_private, auto_process, transcriber, keyterms, kind, text_for_feed_id, backfill, followed, created_at) VALUES (?, ?, ?, ?, ?, 'elevenlabs', ?, ?, ?, ?, ?, ?)",
      [id, Data(normalized.utf8), hash, isPrivate, autoProcess, keyterms, "podcast", SQLValue.null, backfill, followed, now()])
    return try feedRow(id)
  }

  func listFeeds(followed: Bool?) throws -> JSON {
    let filter = followed.map { "WHERE followed = \($0 ? 1 : 0)" } ?? ""
    let rows = try db.all("SELECT * FROM feed \(filter) ORDER BY title COLLATE NOCASE, created_at")
    return .array(try rows.map { try feedView(FeedRow($0)) })
  }

  /// Unfollowing a show also makes it manual, so a show outside the library never transcribes on its own.
  func updateFeed(_ id: String, _ patch: UpdateFeedInput) throws -> JSON {
    let row = try feedRow(id)
    let followed = patch.followed ?? row.followed
    var sets: [String] = []
    var args: [any SQLBindable] = []
    if let title = patch.title {
      sets.append("title = ?")
      args.append(title)
    }
    if let isPrivate = patch.isPrivate {
      sets.append("is_private = ?")
      args.append(isPrivate)
    }
    if let followed = patch.followed {
      sets.append("followed = ?")
      args.append(followed)
    }
    if !followed {
      sets.append("auto_process = 0")
    } else if let autoProcess = patch.autoProcess {
      sets.append("auto_process = ?")
      args.append(autoProcess)
    }
    if let transcriber = patch.transcriber {
      sets.append("transcriber = ?")
      args.append(transcriber)
    }
    if let keyterms = patch.keyterms {
      sets.append("keyterms = ?")
      args.append(String(decoding: JSON.array(keyterms.map(JSON.string)).data(), as: UTF8.self))
    }
    if let backfill = patch.backfill {
      sets.append("backfill = ?")
      args.append(backfill)
    }
    if !sets.isEmpty { try db.run("UPDATE feed SET \(sets.joined(separator: ", ")) WHERE id = ?", args + [id]) }
    return try feed(id)
  }

  /// Remove a feed and everything under it. The server refuses while a snip references one of its recordings and
  /// unlinks its audio files; the phone has neither snips nor files yet, so only the rows go.
  func deleteFeed(_ id: String) throws {
    _ = try feedRow(id)
    try db.transaction {
      try db.run("UPDATE feed SET text_for_feed_id = NULL WHERE text_for_feed_id = ?", [id])
      try db.run(
        "DELETE FROM playback_state WHERE audio_asset_id IN (SELECT a.id FROM audio_asset a JOIN episode e ON e.id = a.episode_id WHERE e.feed_id = ?)",
        [id])
      try db.run("UPDATE episode SET current_asset_id = NULL WHERE feed_id = ?", [id])
      try db.run("DELETE FROM audio_asset WHERE episode_id IN (SELECT id FROM episode WHERE feed_id = ?)", [id])
      try db.run("DELETE FROM episode WHERE feed_id = ?", [id])
      try db.run("DELETE FROM feed WHERE id = ?", [id])
    }
  }

  func recordFeedError(_ feedId: String, _ message: String) throws {
    try db.run("UPDATE feed SET last_error = ?, last_refresh_at = ? WHERE id = ?", [message, now(), feedId])
  }

  /// The feed answered 304: nothing changed, and the refresh is noted.
  func recordNotModified(_ feedId: String) throws {
    try db.run("UPDATE feed SET last_refresh_at = ?, last_error = NULL WHERE id = ?", [now(), feedId])
  }

  /// The second half of the server's `refreshFeed`, after the document is fetched and parsed: the feed's details
  /// are updated and episodes not seen before are inserted, by identity.
  ///
  /// The phone differs in three ways. Every new episode gets its `audio_asset` here, in the same transaction: the
  /// recording is the publisher's file at the enclosure URL, so there is nothing to wait for (the server makes the
  /// row when its download finishes). An episode already here follows its enclosure when the feed moves it
  /// (`followEnclosure`). And nothing is queued afterwards: no fetch, no transcription, whatever `auto_process` and
  /// `backfill` say.
  func applyRefresh(feedId: String, parsed: ParsedFeed, etag: String?, lastModified: String?) throws -> RefreshReport {
    let now = now()
    var inserted = 0
    try db.transaction {
      var existing = Set(try db.all("SELECT guid FROM episode WHERE feed_id = ?", [feedId]).compactMap { $0.string("guid") })
      try db.run(
        "UPDATE feed SET title = COALESCE(?, title), author = COALESCE(?, author), image_url = COALESCE(?, image_url), site_url = COALESCE(?, site_url), language = COALESCE(?, language), etag = ?, last_modified = ?, last_refresh_at = ?, last_error = NULL WHERE id = ?",
        [parsed.feed.title, parsed.feed.author, parsed.feed.imageUrl, parsed.feed.siteUrl, parsed.feed.language, etag, lastModified, now, feedId])
      for item in parsed.items {
        let chaptersUrl = item.chaptersUrl.map { Data($0.utf8) }
        let feedChapters = item.chapters.map { ChapterPoints.encodeStored($0) }
        let videoUrl = item.videoUrl.map { Data($0.utf8) }
        if existing.contains(item.identity) {
          // Publishers often add chapters after an episode is out, so an existing episode picks up the first ones seen.
          if chaptersUrl != nil || feedChapters != nil {
            try db.run(
              "UPDATE episode SET chapters_url_enc = COALESCE(chapters_url_enc, ?), feed_chapters = COALESCE(feed_chapters, ?) WHERE feed_id = ? AND guid = ? AND (chapters_url_enc IS NULL OR feed_chapters IS NULL)",
              [chaptersUrl, feedChapters, feedId, item.identity])
          }
          if videoUrl != nil {
            try db.run(
              "UPDATE episode SET video_url_enc = COALESCE(video_url_enc, ?) WHERE feed_id = ? AND guid = ? AND video_url_enc IS NULL",
              [videoUrl, feedId, item.identity])
          }
          if !item.enclosureUrl.isEmpty { try followEnclosure(feedId: feedId, item: item) }
          continue
        }
        // An enclosure with no address is no recording; the server stores such an episode and fails to fetch it.
        if item.enclosureUrl.isEmpty { continue }
        let id = newId()
        let assetId = newId()
        // `youtube_id` (the video the notes link) is left null: the phone has no video to offer for it.
        try db.run(
          "INSERT INTO episode (id, feed_id, guid, title, description_html, published_at, first_seen_at, enclosure_url_enc, enclosure_type, enclosure_bytes, duration_hint_ms, image_url, link, chapters_url_enc, feed_chapters, media_kind, youtube_id, video_url_enc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            id, feedId, item.identity, item.title, ShowNotes.sanitize(item.descriptionHtml), item.publishedAt, now, Data(item.enclosureUrl.utf8),
            item.enclosureType, item.enclosureBytes, item.durationHintMs, item.imageUrl, item.link, chaptersUrl, feedChapters, item.mediaKind,
            SQLValue.null, videoUrl,
          ])
        try db.run(
          "INSERT INTO audio_asset (id, episode_id, sha256, bytes, duration_ms, mime, path, pinned, created_at) VALUES (?, ?, '', ?, ?, ?, '', 0, ?)",
          [assetId, id, item.enclosureBytes ?? 0, item.durationHintMs ?? 0, item.enclosureType ?? "audio/mpeg", now])
        try db.run("UPDATE episode SET current_asset_id = ? WHERE id = ? AND current_asset_id IS NULL", [assetId, id])
        // A feed that repeats a guid would break the server's insert (the pair is unique); here the first wins.
        existing.insert(item.identity)
        inserted += 1
      }
    }
    return RefreshReport(feedId: feedId, notModified: false, newEpisodes: inserted, skipped: parsed.skipped)
  }

  /// Keep a known episode's recording pointed at where the feed says it is now.
  ///
  /// The server has no such step: it plays its own copy, so an address that later moves or expires costs it
  /// nothing. The phone plays the publisher's file from the address itself, and feeds do change it: a show moves
  /// to another host, and a paid feed signs each address for a few hours. The recording keeps its id (and so its
  /// place and its spot in Up next); only where it is fetched from, and what the feed says of its type and size,
  /// follow the feed. A recording that has been downloaded (`path` set, a later step) is left alone: its file is
  /// the one every stored time refers to.
  private func followEnclosure(feedId: String, item: FeedItem) throws {
    let changed = try db.run(
      "UPDATE episode SET enclosure_url_enc = ?, enclosure_type = ?, enclosure_bytes = ? WHERE feed_id = ? AND guid = ? AND enclosure_url_enc != ?",
      [Data(item.enclosureUrl.utf8), item.enclosureType, item.enclosureBytes, feedId, item.identity, Data(item.enclosureUrl.utf8)])
    guard changed > 0 else { return }
    try db.run(
      "UPDATE audio_asset SET mime = ?, bytes = ? WHERE path = '' AND id = (SELECT current_asset_id FROM episode WHERE feed_id = ? AND guid = ?)",
      [item.enclosureType ?? "audio/mpeg", item.enclosureBytes ?? 0, feedId, item.identity])
  }

  /// Followed feeds whose last refresh, successful or not, is older than `olderThanMs`, the longest waiting first.
  /// The server's scheduled run takes every followed feed (`scheduledFeedIds`); the age is the phone's, because
  /// the app asks at every launch rather than on a timer.
  func staleFollowedFeedIds(olderThanMs: Int) throws -> [String] {
    try db.all(
      "SELECT id FROM feed WHERE followed = 1 AND (last_refresh_at IS NULL OR last_refresh_at < ?) ORDER BY COALESCE(last_refresh_at, 0), id",
      [now() - olderThanMs]
    ).compactMap { $0.string("id") }
  }

  /// Every feed's id and whether it is followed, by the hash of its address: how search results are marked.
  func feedsByHash() throws -> [String: (id: String, followed: Bool)] {
    var out: [String: (id: String, followed: Bool)] = [:]
    for row in try db.all("SELECT id, url_hash, followed FROM feed") {
      if let id = row.string("id"), let hash = row.string("url_hash") { out[hash] = (id, row.bool("followed")) }
    }
    return out
  }

  /// A few of a feed's newest episodes that name a JSON chapters file not yet fetched (`fetchPendingFeedChapters`).
  func episodesAwaitingChapters(feedId: String, limit: Int) throws -> [String] {
    try db.all(
      "SELECT id FROM episode WHERE feed_id = ? AND current_asset_id IS NOT NULL AND chapters_url_enc IS NOT NULL AND feed_chapters IS NULL ORDER BY published_at DESC LIMIT ?",
      [feedId, limit]
    ).compactMap { $0.string("id") }
  }

  /// The episode's chapters file, when it names one that has not been fetched.
  func pendingChaptersUrl(episodeId: String) throws -> String? {
    guard let row = try db.get("SELECT chapters_url_enc, feed_chapters FROM episode WHERE id = ?", [episodeId]) else { return nil }
    return row.string("feed_chapters") == nil ? row.string("chapters_url_enc") : nil
  }

  func storeFeedChapters(episodeId: String, points: [ChapterPoint]?) throws {
    try db.run("UPDATE episode SET feed_chapters = ? WHERE id = ? AND feed_chapters IS NULL", [ChapterPoints.encodeStored(points), episodeId])
  }
}
