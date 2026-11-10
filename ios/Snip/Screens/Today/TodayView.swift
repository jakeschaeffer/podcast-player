import PlayerKit
import PodcastAPI
import SwiftUI

/// Continue listening (the newest in-progress episode) and new episodes across all feeds. The queue button in the bar
/// pushes Up Next (UpNextView), as a player's queue button does; it is the way to the queue with nothing playing.
struct TodayView: View {
  @Environment(AppModel.self) private var model
  @Environment(PlayerEngine.self) private var engine
  @Binding var showPlayer: Bool
  /// The Today tab's navigation; the account menu pushes Prompts onto it.
  @Binding var path: NavigationPath
  @AppStorage(TranscriptTextSize.key) private var transcriptTextSize = TranscriptTextSize.large
  @AppStorage(SidewaysPlayer.key) private var sideways = SidewaysPlayer.karaoke
  @AppStorage(MediaFilter.key) private var mediaFilter = MediaFilter.all
  @State private var episodes: [Episode] = []
  @State private var error: String?
  @State private var loaded = false

  private var current: Episode? {
    episodes
      .filter { ($0.resume.map { !$0.finished && $0.positionMs > 0 }) ?? false }
      .max { ($0.resume?.updatedAt ?? 0) < ($1.resume?.updatedAt ?? 0) }
  }

  var body: some View {
    List {
      if let error {
        Text(error).foregroundStyle(.secondary)
      }
      // With no connection, what is on the phone is what there is to play.
      if error != nil, !model.downloads.items.isEmpty {
        Section("On the phone") {
          ForEach(model.downloads.items.sorted { $0.createdAt > $1.createdAt }) { d in
            DownloadRow(download: d) {
              engine.open(d.episodeID)
              showPlayer = true
            }
          }
        }
      }
      if let current {
        Section("Continue listening") {
          EpisodeRow(episode: current) { open(current) }
            .episodeActions(current) { open(current, playing: true) }
        }
      }
      Section("New episodes") {
        MediaFilter.picker($mediaFilter)
        // The server lists an unfollowed show's episode only while it is in progress, for Continue listening.
        ForEach(episodes.filter { $0.id != current?.id && !model.unfollowedFeeds.contains($0.feedId) && mediaFilter.includes($0.mediaKind) }.prefix(15)) { ep in
          EpisodeRow(episode: ep) { open(ep) }
            .episodeActions(ep) { open(ep, playing: true) }
        }
      }
    }
    .overlay { if !loaded && error == nil { ProgressView() } }
    .navigationTitle("Today")
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button("Up Next", systemImage: "text.line.last.and.arrowtriangle.forward") { path.append(UpNextRoute()) }
      }
      ToolbarItem(placement: .topBarTrailing) {
        Menu {
          Text(model.serverURL.host() ?? "")
          Button("Downloads", systemImage: "arrow.down.circle") { path.append(DownloadsRoute()) }
          Button("Prompts", systemImage: "text.quote") { path.append(PromptRoute.list) }
          Divider()
          TranscriptTextSize.picker($transcriptTextSize).pickerStyle(.menu)
          SidewaysPlayer.picker($sideways).pickerStyle(.menu)
          Button("Sign out", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) { model.signOut() }
        } label: {
          Image(systemName: "person.crop.circle")
        }
      }
    }
    .promptDestinations()
    .navigationDestination(for: DownloadsRoute.self) { _ in DownloadsView(showPlayer: $showPlayer) }
    .navigationDestination(for: UpNextRoute.self) { _ in UpNextView(showPlayer: $showPlayer) }
    .task { await load() }
    .refreshable { await load() }
  }

  private func load() async {
    // What was read last time shows at once; the server's answer replaces it when it comes.
    if !loaded, episodes.isEmpty, let saved = model.api.savedEpisodes(limit: 30), !saved.isEmpty {
      episodes = saved
      loaded = true
    }
    do {
      // The shows (for artwork, and which are unfollowed) are asked for alongside the episodes, not before them.
      // Up next too, so the queue button opens on it at once and its first episodes download as the setting says.
      async let feeds = model.feeds()
      async let queue: Void = model.refreshQueue()
      episodes = try await model.api.episodes(limit: 30).items
      _ = try? await feeds
      await queue
      error = nil
    } catch {
      self.error = error.localizedDescription
    }
    loaded = true
  }

  /// Opening an episode shows it in the player without starting it, unless asked to play (its row's Play action).
  private func open(_ ep: Episode, playing: Bool = false) {
    engine.open(ep.id, autoplay: playing)
    showPlayer = true
  }
}

extension View {
  /// A list episode's other actions, beside tapping it to open it: swipe right, or press and hold, to play it now or
  /// to add it to the end of Up next.
  func episodeActions(_ episode: Episode, play: @escaping () -> Void) -> some View {
    modifier(EpisodeActions(episode: episode, play: play))
  }
}

private struct EpisodeActions: ViewModifier {
  @Environment(AppModel.self) private var model
  let episode: Episode
  let play: () -> Void
  @State private var added = 0

  func body(content: Content) -> some View {
    content
      .swipeActions(edge: .leading) {
        Button("Up Next", systemImage: "text.line.last.and.arrowtriangle.forward") { add() }
          .tint(.accentColor)
        Button("Download", systemImage: "arrow.down.circle") { model.downloadEpisode(episode.id) }
          .tint(.gray)
      }
      .contextMenu {
        Button("Play", systemImage: "play.fill", action: play)
        Button("Add to Up Next", systemImage: "text.line.last.and.arrowtriangle.forward") { add() }
        Button("Download", systemImage: "arrow.down.circle") { model.downloadEpisode(episode.id) }
      }
      .sensoryFeedback(.success, trigger: added)
  }

  private func add() {
    model.addToQueue(episode)
    added += 1
  }
}

struct EpisodeRow: View {
  @Environment(AppModel.self) private var model
  let episode: Episode
  /// Off on a show's own page, where the name would only repeat.
  var showsShow = true
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 12) {
        Artwork(url: model.artwork(episodeImage: episode.imageUrl, feedID: episode.feedId), size: 52)
        VStack(alignment: .leading, spacing: 3) {
          if showsShow { Text(episode.showTitle ?? "").font(.caption).foregroundStyle(.secondary).lineLimit(1) }
          Text(episode.title).font(.body.weight(.medium)).lineLimit(2)
          Text(detail).font(.caption).foregroundStyle(.secondary)
        }
      }
    }
    .buttonStyle(.plain)
  }

  private var detail: String {
    var parts: [String] = []
    if let published = episode.publishedAt {
      parts.append(Date(timeIntervalSince1970: Double(published) / 1000).formatted(.relative(presentation: .named)))
    }
    if let resume = episode.resume, !resume.finished, resume.positionMs > 0, let total = episode.durationMs {
      parts.append("\(Format.clock(total - resume.positionMs)) left")
    } else if let total = episode.durationMs {
      parts.append(Format.clock(total))
    }
    if episode.mediaKind == "video" || episode.video.isReady { parts.append("Video") }
    if !model.downloads.downloads(episodeID: episode.id).isEmpty { parts.append("On the phone") }
    return parts.joined(separator: " · ")
  }
}

enum Format {
  /// 1:02:03 or 4:05.
  static func clock(_ ms: Int) -> String {
    let total = max(0, ms / 1000)
    let (h, m, s) = (total / 3600, total / 60 % 60, total % 60)
    return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
  }

  /// A short length in words: "55 sec", "2 min 5 sec", "3 min".
  static func duration(_ ms: Int) -> String {
    let total = max(0, Int((Double(ms) / 1000).rounded()))
    let (m, s) = (total / 60, total % 60)
    if m == 0 { return "\(s) sec" }
    return s == 0 ? "\(m) min" : "\(m) min \(s) sec"
  }
}
