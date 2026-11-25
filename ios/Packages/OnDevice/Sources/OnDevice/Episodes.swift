import Foundation

// A port of server/src/services/episodes.ts: the episode lists, Up next, and one episode as the player needs it.
// The SQL and the ordering rules are the server's. What the server derives from its job queue, transcripts,
// summaries, snips and video files has one fixed answer here, since the phone has none of those yet.

struct EpisodeRow: Sendable {
  let id: String
  let feedId: String
  let title: String
  let descriptionHtml: String?
  let publishedAt: Int?
  let enclosureUrl: String
  let durationHintMs: Int?
  let imageUrl: String?
  let link: String?
  let currentAssetId: String?
  let feedChapters: String?

  init(_ row: Row) {
    id = row.string("id") ?? ""
    feedId = row.string("feed_id") ?? ""
    title = row.string("title") ?? ""
    descriptionHtml = row.string("description_html")
    publishedAt = row.int("published_at")
    enclosureUrl = row.string("enclosure_url_enc") ?? ""
    durationHintMs = row.int("duration_hint_ms")
    imageUrl = row.string("image_url")
    link = row.string("link")
    currentAssetId = row.string("current_asset_id")
    feedChapters = row.string("feed_chapters")
  }
}

struct AssetRow: Sendable {
  let id: String
  let episodeId: String
  let bytes: Int
  let durationMs: Int
  let mime: String

  init(_ row: Row) {
    id = row.string("id") ?? ""
    episodeId = row.string("episode_id") ?? ""
    bytes = row.int("bytes") ?? 0
    durationMs = row.int("duration_ms") ?? 0
    mime = row.string("mime") ?? "audio/mpeg"
  }
}

extension Store {
  func episodeRow(_ id: String) throws -> EpisodeRow {
    guard let row = try db.get("SELECT * FROM episode WHERE id = ?", [id]) else { throw HTTPError.notFound("episode") }
    return EpisodeRow(row)
  }

  func assetRow(_ id: String) throws -> AssetRow {
    guard let row = try db.get("SELECT * FROM audio_asset WHERE id = ?", [id]) else { throw HTTPError.notFound("audio asset") }
    return AssetRow(row)
  }

  /// One episode as lists show it (`toListItem`).
  ///
  /// The phone's fixed answers: the recording is `ready` from the start (it is the publisher's file), and
  /// transcript, text and summary are `none`. The video fields are an audio episode's, whatever the feed carries:
  /// the phone fetches no video, and `available` would offer a button that cannot work.
  ///
  /// `duration_ms` is the feed's figure, or null when the feed gives none. The server's is its own file's measured
  /// length once it has one; the asset's `duration_ms` (0 for "the feed did not say") is a number the phone never
  /// measured, so the list shows it only when the feed supplied it.
  private func listItem(_ ep: EpisodeRow, feedTitle: String?, asset: AssetRow?) throws -> [String: JSON] {
    [
      "id": .string(ep.id),
      "feed_id": .string(ep.feedId),
      "show_title": JSON(feedTitle),
      "title": .string(ep.title),
      "published_at": JSON(ep.publishedAt),
      "duration_ms": JSON(asset.flatMap { $0.durationMs > 0 ? $0.durationMs : nil } ?? ep.durationHintMs),
      "image_url": JSON(ep.imageUrl),
      "asset_id": JSON(asset?.id),
      "transcript_id": nil,
      "has_summary": false,
      "processing": ["audio": asset == nil ? "none" : "ready", "transcript": "none", "text": "none", "summary": "none"],
      "resume": try asset.map { try resume(assetId: $0.id) } ?? .null,
      "media_kind": "audio",
      "youtube_id": nil,
      "video": ["status": "none", "error": nil],
    ]
  }

  private func listItem(row: Row) throws -> JSON {
    let ep = EpisodeRow(row)
    return .object(try listItem(ep, feedTitle: row.string("feed_title"), asset: try ep.currentAssetId.map(assetRow)))
  }

  /// `GET /v1/episodes`: newest first, one feed's or every followed feed's, paged by the `next` cursor.
  func listEpisodes(feedId: String?, after: String?, limit: Int?) throws -> JSON {
    let limit = min(200, max(1, limit ?? 50))
    var conditions: [String] = []
    var args: [any SQLBindable] = []
    if let feedId, !feedId.isEmpty {
      conditions.append("e.feed_id = ?")
      args.append(feedId)
    } else {
      // Across feeds (Today), an unfollowed show's episodes appear only while one is in progress, for Continue listening.
      conditions.append(
        "(f.followed = 1 OR EXISTS (SELECT 1 FROM playback_state p WHERE p.audio_asset_id = e.current_asset_id AND p.finished = 0 AND p.position_ms > 0))")
    }
    if let after, !after.isEmpty {
      // The cursor is `<published_at or 0>_<id>`. One that is not a cursor matches nothing, as on the server,
      // where the number comes out NaN.
      let parts = after.split(separator: "_", omittingEmptySubsequences: false)
      let published = Int(parts[0])
      conditions.append("(COALESCE(e.published_at, 0) < ? OR (COALESCE(e.published_at, 0) = ? AND e.id < ?))")
      args.append(published)
      args.append(published)
      args.append(parts.count > 1 ? String(parts[1]) : nil)
    }
    args.append(limit + 1)
    let rows = try db.all(
      "SELECT e.*, f.title AS feed_title FROM episode e JOIN feed f ON f.id = e.feed_id WHERE \(conditions.joined(separator: " AND ")) ORDER BY COALESCE(e.published_at, 0) DESC, e.id DESC LIMIT ?",
      args)
    let page = rows.prefix(limit)
    var next = JSON.null
    if rows.count > limit, let last = page.last {
      next = .string("\(last.int("published_at") ?? 0)_\(last.string("id") ?? "")")
    }
    return ["items": .array(try page.map(listItem(row:))), "next": next]
  }

  /// Up next: every episode started and not finished, and every one the owner added, in the owner's order.
  /// Episodes without a place (heard partway and never moved, or listened to since they were placed) come first,
  /// the one listened to most recently first, so leaving one episode for another puts the one left at the top;
  /// then the placed ones in the owner's order. Removing one takes it out until it is played again or added back.
  func listQueue(limit: Int?) throws -> JSON {
    let limit = min(200, max(1, limit ?? 50))
    let rows = try db.all(
      """
      WITH latest AS (
        SELECT audio_asset_id, position_ms, finished, COALESCE(observed_at, updated_at) AS at,
               ROW_NUMBER() OVER (PARTITION BY audio_asset_id ORDER BY COALESCE(observed_at, updated_at) DESC) AS rn
        FROM playback_state)
      SELECT e.*, f.title AS feed_title, l.at AS heard_at, l.finished AS heard_finished, l.position_ms AS heard_position,
             u.position, u.placed_at, u.added_at, u.hidden_at
      FROM episode e
      JOIN feed f ON f.id = e.feed_id
      LEFT JOIN latest l ON l.audio_asset_id = e.current_asset_id AND l.rn = 1
      LEFT JOIN up_next u ON u.episode_id = e.id
      WHERE (l.finished = 0 AND l.position_ms > 0) OR u.added_at IS NOT NULL
      """)
    struct Entry {
      let row: Row
      let id: String
      let heard: Int
      let placed: Bool
      let position: Double
      let recency: Int
    }
    let entries: [Entry] = rows.filter(Self.inQueue).map { row in
      let heard = row.int("heard_at") ?? 0
      let position = row.double("position")
      let placedAt = row.int("placed_at")
      return Entry(
        row: row, id: row.string("id") ?? "", heard: heard,
        placed: position != nil && placedAt != nil && placedAt! >= heard, position: position ?? 0,
        recency: max(heard, row.int("added_at") ?? 0))
    }
    let sorted = entries.sorted { a, b in
      if a.placed != b.placed { return !a.placed }
      if a.placed { return a.position != b.position ? a.position < b.position : a.id < b.id }
      return a.recency != b.recency ? a.recency > b.recency : a.id > b.id
    }
    return ["items": .array(try sorted.prefix(limit).map { try listItem(row: $0.row) })]
  }

  /// Heard partway, or added (and not finished since), and not removed since either.
  private static func inQueue(_ row: Row) -> Bool {
    let heardAt = row.int("heard_at")
    let heard = heardAt ?? 0
    let finished = row.int("heard_finished")
    let halfHeard = finished == 0 && (row.int("heard_position") ?? 0) > 0
    let addedAt = row.int("added_at")
    let added = addedAt != nil && (heardAt == nil || finished == 0 || addedAt! > heard)
    let hiddenAt = row.int("hidden_at")
    let removed = hiddenAt != nil && hiddenAt! >= heard && hiddenAt! >= (addedAt ?? 0)
    return (halfHeard || added) && !removed
  }

  /// The owner's order for these episodes, first to last; episodes left out keep their places.
  func setQueueOrder(_ episodeIds: [String]) throws -> JSON {
    let now = now()
    try db.transaction {
      for (i, id) in episodeIds.enumerated() {
        _ = try episodeRow(id)
        try db.run(
          """
          INSERT INTO up_next (episode_id, position, placed_at) VALUES (?, ?, ?)
          ON CONFLICT (episode_id) DO UPDATE SET position = excluded.position, placed_at = excluded.placed_at
          """, [id, i, now])
      }
    }
    return try listQueue(limit: 200)
  }

  /// Add an episode to Up next (again, if it was finished or removed): to the top, to play next, or to the end.
  /// At the top it goes in unplaced and just added, so it comes first, above the ones heard partway; at the end it
  /// takes the place after the last placed one.
  ///
  /// On the server, adding also asks for the episode's recording, transcript and summary at once. The phone's
  /// recording is already there and it transcribes nothing, so adding only places the episode.
  func addToQueue(_ episodeId: String, atStart: Bool) throws -> JSON {
    _ = try episodeRow(episodeId)
    let now = now()
    let last = try db.get("SELECT MAX(position) AS p FROM up_next WHERE episode_id != ?", [episodeId])?.double("p")
    let position: Double? = atStart ? nil : (last ?? -1) + 1
    try db.run(
      """
      INSERT INTO up_next (episode_id, position, placed_at, added_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (episode_id) DO UPDATE SET position = excluded.position, placed_at = excluded.placed_at, added_at = excluded.added_at, hidden_at = NULL
      """, [episodeId, position, position == nil ? nil : now, now])
    return try listQueue(limit: 200)
  }

  /// Take an episode out of Up next without marking it played; listening to it again or adding it brings it back.
  func removeFromQueue(_ episodeId: String) throws -> JSON {
    _ = try episodeRow(episodeId)
    try db.run(
      """
      INSERT INTO up_next (episode_id, hidden_at) VALUES (?, ?)
      ON CONFLICT (episode_id) DO UPDATE SET hidden_at = excluded.hidden_at, position = NULL, placed_at = NULL, added_at = NULL
      """, [episodeId, now()])
    return try listQueue(limit: 200)
  }

  /// `GET /v1/episodes/{id}`: the list fields plus what the player needs.
  ///
  /// The phone differs: `asset.audio_url` is the publisher's enclosure URL, as the feed gave it, where the server
  /// signs a link to its own copy. It does not expire and needs no signature, and what it plays can differ between
  /// fetches (inserted ads). `asset.bytes`, `mime` and `duration_ms` are the feed's claims, 0 when it makes none;
  /// the player should trust the file over them. Chapters are the publisher's (the feed's, else the show notes')
  /// or none: there is no summary to take the model's from. `text` and `summary` are null, `snip_count` 0 and
  /// `ad_breaks` empty until the steps that make them exist on the phone.
  func episode(_ id: String) throws -> JSON {
    let ep = try episodeRow(id)
    let feed = try feedRow(ep.feedId)
    let asset = try ep.currentAssetId.map(assetRow)
    var out = try listItem(ep, feedTitle: feed.title, asset: asset)
    out["description_html"] = JSON(ep.descriptionHtml)
    out["link"] = JSON(ep.link)
    out["text"] = nil
    out["chapters"] = ChapterPoints.published(
      feedChapters: ep.feedChapters, descriptionHtml: ep.descriptionHtml,
      durationMs: asset.flatMap { $0.durationMs > 0 ? $0.durationMs : nil } ?? ep.durationHintMs)
    out["asset"] =
      asset.map {
        [
          "id": .string($0.id), "duration_ms": .int($0.durationMs), "mime": .string($0.mime), "bytes": .int($0.bytes),
          "audio_url": .string(ep.enclosureUrl), "video_url": nil, "video_width": nil, "video_height": nil, "video_bytes": nil,
        ]
      } ?? .null
    out["summary"] = nil
    out["snip_count"] = 0
    out["ad_breaks"] = []
    return .object(out)
  }
}
