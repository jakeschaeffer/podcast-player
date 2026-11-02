import Foundation

// The routes v1 uses, one method each. Paths and bodies follow server/openapi.json.

extension APIClient {
  // MARK: Devices

  struct LoginBody: Encodable {
    let name: String
    let platform: String
    let password: String
  }

  public func login(password: String, deviceName: String) async throws -> DeviceLogin {
    try await send("POST", "/v1/devices", body: LoginBody(name: deviceName, platform: "ios", password: password))
  }

  public func health() async throws -> Health {
    try await send("GET", "/v1/health")
  }

  // MARK: Feeds and episodes

  public func feeds() async throws -> [Feed] {
    try await send("GET", "/v1/feeds")
  }

  /// Shows in the public directory matching `query` (2–200 characters).
  public func searchShows(_ query: String, limit: Int = 20) async throws -> ShowSearch {
    try await send(
      "GET", "/v1/search/shows",
      query: [URLQueryItem(name: "q", value: query), URLQueryItem(name: "limit", value: String(limit))])
  }

  /// Subscribes (or opens a show unfollowed); the first feed refresh runs in the background, so poll `feed(_:)` until
  /// `lastRefreshAt` is set. A URL the server already has fails with 409 and `APIError.feedId`.
  public func createFeed(_ body: CreateFeed) async throws -> Feed {
    try await send("POST", "/v1/feeds", body: body)
  }

  public func updateFeed(_ id: ULID, _ body: UpdateFeed) async throws -> Feed {
    try await send("PATCH", "/v1/feeds/\(id)", body: body)
  }

  /// Queues a refresh (free: it reads the RSS); poll `feed(_:)` until `lastRefreshAt` moves. Unfollowed shows are
  /// not refreshed on a schedule, so opening one asks for this.
  public func refreshFeed(_ id: ULID) async throws {
    try await sendIgnoringBody("POST", "/v1/feeds/\(id)/refresh")
  }

  public func feed(_ id: ULID) async throws -> Feed {
    try await send("GET", "/v1/feeds/\(id)")
  }

  public func episodes(feedID: ULID? = nil, limit: Int = 30, after: String? = nil) async throws -> Page<Episode> {
    var query = [URLQueryItem(name: "limit", value: String(limit))]
    if let feedID { query.append(URLQueryItem(name: "feed_id", value: feedID)) }
    if let after { query.append(URLQueryItem(name: "after", value: after)) }
    return try await send("GET", "/v1/episodes", query: query)
  }

  /// Up next in the owner's order: episodes not yet placed (heard partway, most recently listened first, on any
  /// device) come first, then the placed and added ones. Includes the one playing.
  public func queue(limit: Int = 50) async throws -> [Episode] {
    let page: QueuePage = try await send("GET", "/v1/queue", query: [URLQueryItem(name: "limit", value: String(limit))])
    return page.items
  }

  /// Put Up next in this order, first to last; returns the new Up next.
  public func reorderQueue(_ episodeIDs: [ULID]) async throws -> [Episode] {
    let page: QueuePage = try await send("PUT", "/v1/queue", body: QueueOrder(episodeIds: episodeIDs))
    return page.items
  }

  /// Add an episode to the end of Up next; returns the new Up next.
  public func addToQueue(_ episodeID: ULID) async throws -> [Episode] {
    let page: QueuePage = try await send("POST", "/v1/queue/\(episodeID)")
    return page.items
  }

  /// Take an episode out of Up next without marking it played; returns the new Up next.
  public func removeFromQueue(_ episodeID: ULID) async throws -> [Episode] {
    let page: QueuePage = try await send("DELETE", "/v1/queue/\(episodeID)")
    return page.items
  }

  public func episode(_ id: ULID) async throws -> EpisodeDetail {
    try await send("GET", "/v1/episodes/\(id)")
  }

  /// Asks the server to fetch the recording; poll `episode(_:)` until `asset` is set.
  public func prepareAudio(_ episodeID: ULID) async throws -> EpisodeDetail {
    try await send("POST", "/v1/episodes/\(episodeID)/audio")
  }

  /// Ask for the episode's video (docs/video-plan.md): a feed's own file the server fetches; a YouTube video the
  /// home fetcher brings. `video.status` on the episode says how it is going.
  public func requestVideo(_ episodeID: ULID) async throws -> EpisodeDetail {
    try await send("POST", "/v1/episodes/\(episodeID)/video")
  }

  /// A pasted YouTube video link becomes an episode of its channel's show (created unfollowed if the library lacks
  /// it) with its video asked for; a video an episode already names is that episode. 400 for anything else.
  public func addYouTubeVideo(_ url: String) async throws -> EpisodeDetail {
    try await send("POST", "/v1/youtube/episodes", body: ["url": url])
  }

  /// A pasted link to a video or audio file becomes a one-off episode of the Pasted links show, which the server
  /// downloads and transcribes (billed); the same link twice is the same episode. A YouTube video link is handled as
  /// `addYouTubeVideo` would; a link to a web page is refused with a message. The title, when given, names the
  /// episode; else the file's name, or where it came from.
  public func addPastedLink(_ url: String, title: String? = nil) async throws -> EpisodeDetail {
    var body = ["url": url]
    if let title, !title.isEmpty { body["title"] = title }
    return try await send("POST", "/v1/links/episodes", body: body)
  }

  /// Fetch the recording if needed, transcribe it, align any publisher text, and summarize. Transcription bills
  /// (ElevenLabs, per audio hour), so only ever on the listener's explicit request. Idempotent.
  public func processEpisode(_ id: ULID) async throws -> EpisodeDetail {
    try await send("POST", "/v1/episodes/\(id)/process")
  }

  public func transcript(_ id: ULID) async throws -> Transcript {
    try await send("GET", "/v1/transcripts/\(id)")
  }

  /// Who the transcript's voices are; nil until the server has worked it out (asking queues that).
  public func speakers(_ transcriptID: ULID) async throws -> [Speaker]? {
    let response: SpeakersResponse = try await send("GET", "/v1/transcripts/\(transcriptID)/speakers")
    return response.speakers
  }

  // MARK: Playback

  public func reportPlayback(assetID: ULID, _ report: PlaybackReport) async throws -> PlaybackAck {
    try await send("PUT", "/v1/playback/\(assetID)", body: report)
  }

  // MARK: Snips

  public func createSnip(_ body: CreateSnip) async throws -> Snip {
    try await send("POST", "/v1/snips", body: body)
  }

  public func snip(_ id: ULID) async throws -> Snip {
    try await send("GET", "/v1/snips/\(id)")
  }

  /// The snip if it changed since `etag`, else nil (the server answers 304; its ETag covers status, title and note).
  public func snip(_ id: ULID, ifNoneMatch etag: String?) async throws -> (value: Snip, etag: String?)? {
    try await getIfChanged("/v1/snips/\(id)", etag: etag)
  }

  /// Title and/or boundaries. A boundary change makes a new revision that is `preparing` until its clip renders.
  public func editSnip(_ id: ULID, _ body: EditSnip) async throws -> Snip {
    try await send("PATCH", "/v1/snips/\(id)", body: body)
  }

  /// Deletes a snip: its link stops serving and, if its moment is still being chosen, the work on it stops.
  public func deleteSnip(_ id: ULID) async throws {
    try await sendIgnoringBody("DELETE", "/v1/snips/\(id)")
  }

  public func snips(episodeID: ULID? = nil, limit: Int = 30, after: String? = nil) async throws -> Page<Snip> {
    var query = [URLQueryItem(name: "limit", value: String(limit))]
    if let episodeID { query.append(URLQueryItem(name: "episode_id", value: episodeID)) }
    if let after { query.append(URLQueryItem(name: "after", value: after)) }
    return try await send("GET", "/v1/snips", query: query)
  }

  // MARK: Prompts and evals

  struct PromptTextBody: Encodable { let text: String }
  struct VersionBody: Encodable { let version: String }

  public func prompts() async throws -> [Prompt] {
    try await send("GET", "/v1/prompts")
  }

  public func promptVersion(_ name: String, _ version: String) async throws -> PromptVersion {
    try await send("GET", "/v1/prompts/\(name)/versions/\(version)")
  }

  /// Saves `text` as the next version, not yet active. The server commits it to git; 409 when another version
  /// already has the same text.
  public func createPromptVersion(_ name: String, text: String) async throws -> PromptVersion {
    try await send("POST", "/v1/prompts/\(name)/versions", body: PromptTextBody(text: text))
  }

  /// Makes `version` the one production uses from its next model call; the server commits the change to git.
  public func activatePrompt(_ name: String, version: String) async throws -> Prompt {
    try await send("PUT", "/v1/prompts/\(name)/active", body: VersionBody(version: version))
  }

  /// Queues a run of `eval` on one version (a run already waiting for it is returned); 409 without a text model.
  public func startEvalRun(_ eval: String, version: String) async throws -> EvalRun {
    try await send("POST", "/v1/evals/\(eval)/runs", body: VersionBody(version: version))
  }

  public func evalRun(_ eval: String, _ run: String) async throws -> EvalRunDetail {
    try await send("GET", "/v1/evals/\(eval)/runs/\(run)")
  }

  // MARK: Sharing an episode's snips

  /// The public page with every shared snip of an episode (`/e/{token}`), or nil if it was never shared.
  public func episodeShare(_ episodeID: ULID) async throws -> EpisodeShare? {
    try await send("GET", "/v1/episodes/\(episodeID)/share")
  }

  /// Publish the page (or bring a withdrawn one back at the same link).
  public func shareEpisode(_ episodeID: ULID) async throws -> EpisodeShare {
    try await send("POST", "/v1/episodes/\(episodeID)/share")
  }

  public func revokeEpisodeShare(_ episodeID: ULID) async throws -> EpisodeShare {
    try await send("POST", "/v1/episodes/\(episodeID)/share/revoke")
  }
}
