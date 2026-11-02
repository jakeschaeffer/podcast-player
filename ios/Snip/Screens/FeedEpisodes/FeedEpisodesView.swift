import PlayerKit
import PodcastAPI
import SwiftUI

/// One show: Follow, and its episodes paged with the server's `next` cursor. A show opened a moment ago has not been
/// fetched yet (its first refresh is a queued job on the server), so until then it polls the feed and says so. An
/// unfollowed show isn't refreshed on a schedule, so opening one whose last refresh is stale asks for one (free: it
/// only reads the RSS).
struct FeedEpisodesView: View {
  @Environment(AppModel.self) private var model
  @Environment(PlayerEngine.self) private var engine
  @State private var feed: Feed
  @Binding var showPlayer: Bool
  @State private var episodes: [Episode] = []
  @State private var next: String?
  @State private var error: String?
  @State private var loading = false
  @State private var loaded = false
  @State private var savingFollow = false

  /// Like the web's FeedEpisodes: poll every 2 s, and stop after 90 s.
  private static let pollInterval = Duration.seconds(2)
  private static let pollGiveUp = Duration.seconds(90)
  /// An unfollowed show last read longer ago than this is refreshed when opened.
  private static let staleAfterMs = 30 * 60 * 1000

  init(feed: Feed, showPlayer: Binding<Bool>) {
    _feed = State(initialValue: feed)
    _showPlayer = showPlayer
  }

  private var fetching: Bool { feed.lastRefreshAt == nil && feed.lastError == nil }
  /// Feeds from a server without the field were all followed.
  private var following: Bool { feed.followed != false }

  var body: some View {
    List {
      Section { header }
      Section {
        if let error {
          Text(error).foregroundStyle(.secondary)
        }
        if let lastError = feed.lastError {
          Text("Couldn’t read this feed: \(lastError)").foregroundStyle(.red)
        }
        if fetching && episodes.isEmpty {
          HStack(spacing: 8) {
            ProgressView()
            Text("Fetching episodes…").foregroundStyle(.secondary)
          }
        } else if loaded && !loading && episodes.isEmpty && error == nil && feed.lastError == nil {
          Text("This feed has no episodes.").foregroundStyle(.secondary)
        }
        ForEach(episodes) { ep in
          EpisodeRow(episode: ep, showsShow: false) {
            engine.open(ep.id)
            showPlayer = true
          }
          .episodeActions(ep) {
            engine.open(ep.id, autoplay: true)
            showPlayer = true
          }
          .onAppear { if ep.id == episodes.last?.id, next != nil { Task { await loadMore() } } }
        }
        if loading { ProgressView().frame(maxWidth: .infinity) }
      }
    }
    .listSectionSpacing(24)
    .navigationTitle(feed.title ?? "Untitled show")
    .navigationBarTitleDisplayMode(.inline)
    .task {
      guard !loaded else { return }
      if fetching {
        await waitForRefresh(after: nil)
        await loadMore()
        return
      }
      guard !following, let last = feed.lastRefreshAt, nowMs - last > Self.staleAfterMs,
        (try? await model.api.refreshFeed(feed.id)) != nil
      else {
        await loadMore()
        return
      }
      // List what the server has while the refresh runs, then again if it found new episodes.
      let count = feed.episodeCount
      await loadMore()
      await waitForRefresh(after: last)
      if feed.episodeCount != count { await reload() }
    }
    .refreshable { await reload() }
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 12) {
        Artwork(url: feed.imageUrl, size: 64)
        VStack(alignment: .leading, spacing: 3) {
          Text(feed.title ?? "Untitled show").font(.headline).lineLimit(2)
          if let author = feed.author {
            Text(author).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
          }
        }
      }
      if feed.kind != "links" {
        Group {
          if following {
            Button {
              Task { await setFollowing(false) }
            } label: {
              Label("Following", systemImage: "checkmark").frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
          } else {
            Button {
              Task { await setFollowing(true) }
            } label: {
              Label("Follow", systemImage: "plus").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
          }
        }
        .disabled(savingFollow)
      }
      Text(note).font(.footnote).foregroundStyle(.secondary)
    }
    .padding(.vertical, 4)
  }

  private var note: String {
    // The Pasted links show is no subscription: each episode is a file the owner pasted or shared, downloaded and
    // transcribed when it was added.
    if feed.kind == "links" { return "Links you pasted or shared, each downloaded and transcribed when it was added. Nothing to follow." }
    let library =
      following
      ? "In your Library, with new episodes in Today."
      : "Follow to keep this show in your Library and its new episodes in Today."
    return feed.autoProcess ? library : "\(library) Manual: nothing is transcribed until you ask."
  }

  private var nowMs: Int { Int(Date.now.timeIntervalSince1970 * 1000) }

  /// Unfollowing also makes a show manual (the server's rule), which `feed` then shows.
  private func setFollowing(_ follow: Bool) async {
    savingFollow = true
    defer { savingFollow = false }
    do {
      feed = try await model.api.updateFeed(feed.id, UpdateFeed(followed: follow))
      _ = try? await model.feeds()  // Today reads which shows are followed from here
      error = nil
    } catch {
      self.error = error.localizedDescription
    }
  }

  /// Polls the feed until its `lastRefreshAt` moves past `previous` (a failed refresh sets it too), or gives up.
  private func waitForRefresh(after previous: Int?) async {
    let deadline = ContinuousClock.now + Self.pollGiveUp
    while ContinuousClock.now < deadline {
      do {
        try await Task.sleep(for: Self.pollInterval)
      } catch {
        return  // left the screen
      }
      guard let fresh = try? await model.api.feed(feed.id) else { continue }
      feed = fresh
      if fresh.lastRefreshAt != previous { break }
    }
    _ = try? await model.feeds()  // the show's artwork, for its episode rows
  }

  private func reload() async {
    episodes = []
    next = nil
    await loadMore()
  }

  private func loadMore() async {
    guard !loading else { return }
    loading = true
    defer {
      loading = false
      loaded = true
    }
    do {
      let page = try await model.api.episodes(feedID: feed.id, limit: 30, after: next)
      episodes += page.items
      next = page.next
      error = nil
    } catch {
      self.error = error.localizedDescription
    }
  }
}
