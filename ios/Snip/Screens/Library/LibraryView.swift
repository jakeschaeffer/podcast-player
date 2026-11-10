import PodcastAPI
import SwiftUI

/// The shows (podcast feeds). A text feed is the publisher's articles for a show, so it is listed as a tag on
/// that show rather than on its own, like the web Library.
struct LibraryView: View {
  @Environment(AppModel.self) private var model
  @Binding var showPlayer: Bool
  @State private var feeds: [Feed] = []
  @State private var error: String?
  @State private var loaded = false
  @State private var searching = false
  @State private var searchText = ""
  /// A show opened by something other than a row (the DEBUG `-openFeed` launch argument).
  @State private var opened: Feed?

  /// Shows opened from search without following them aren't in the library.
  @AppStorage(MediaFilter.key) private var mediaFilter = MediaFilter.all
  /// Podcasts and YouTube channels the owner follows, as the filter allows, and the Pasted links show, which holds
  /// videos and audio alike and so stays under either filter.
  private var shows: [Feed] {
    feeds.filter {
      ($0.kind == "podcast" || $0.kind == "youtube" || $0.kind == "links") && $0.followed != false
        && ($0.kind == "links" || mediaFilter.includes($0.kind == "youtube" ? "video" : "audio"))
    }
  }
  private var showsWithText: Set<ULID> { Set(feeds.filter { $0.kind == "text" }.compactMap(\.textForFeedId)) }

  var body: some View {
    List {
      if let error {
        Text(error).foregroundStyle(.secondary)
      }
      MediaFilter.picker($mediaFilter)
      ForEach(shows) { feed in
        NavigationLink(value: feed) {
          HStack(spacing: 12) {
            Artwork(url: feed.imageUrl, size: 52)
            VStack(alignment: .leading, spacing: 3) {
              Text(feed.title ?? "Untitled show").font(.body.weight(.medium)).lineLimit(2)
              HStack(spacing: 4) {
                if feed.isPrivate {
                  Image(systemName: "lock.fill").accessibilityLabel("Private feed")
                }
                Text(detail(for: feed))
              }
              .font(.caption).foregroundStyle(.secondary)
              if let lastError = feed.lastError {
                Text(lastError).font(.caption).foregroundStyle(.red).lineLimit(2)
              }
            }
          }
        }
      }
    }
    .overlay { if !loaded && error == nil { ProgressView() } }
    .navigationTitle("Library")
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button {
          searchText = ""
          searching = true
        } label: {
          Image(systemName: "magnifyingglass").accessibilityLabel("Find a show")
        }
      }
    }
    .navigationDestination(isPresented: $searching) {
      AddShowView(showPlayer: $showPlayer, query: searchText)
    }
    .navigationDestination(item: $opened) { feed in
      FeedEpisodesView(feed: feed, showPlayer: $showPlayer)
    }
    .navigationDestination(for: Feed.self) { feed in
      FeedEpisodesView(feed: feed, showPlayer: $showPlayer)
    }
    // On every return too, not only the first: a show followed (or unfollowed) from its page changes the list.
    .onAppear {
      Task {
        #if DEBUG
          await openFromLaunchArguments()
        #endif
        await load()
      }
    }
    .refreshable { await load() }
  }

  private func detail(for feed: Feed) -> String {
    [
      feed.episodeCount == 1 ? "1 episode" : "\(feed.episodeCount) episodes",
      feed.kind == "youtube" ? "YouTube" : feed.kind == "links" ? "One-offs" : nil,
      showsWithText.contains(feed.id) ? "Publisher text" : nil,
      feed.autoProcess ? nil : "Manual",
    ].compactMap { $0 }.joined(separator: " · ")
  }

  #if DEBUG
    /// `-searchShows <text>` opens show search with that text; `-openFeed <id>` opens that show. For scripted
    /// simulator checks, once per launch.
    private func openFromLaunchArguments() async {
      guard !Self.launchArgumentsUsed else { return }
      Self.launchArgumentsUsed = true
      if let text = UserDefaults.standard.string(forKey: "searchShows") {
        searchText = text
        searching = true
      } else if let id = UserDefaults.standard.string(forKey: "openFeed") {
        opened = try? await model.api.feed(id)
      }
    }
    @MainActor private static var launchArgumentsUsed = false
  #endif

  private func load() async {
    if !loaded, feeds.isEmpty, let saved = model.api.savedFeeds(), !saved.isEmpty {
      feeds = saved
      loaded = true
    }
    do {
      feeds = try await model.feeds()
      error = nil
    } catch {
      self.error = error.localizedDescription
    }
    loaded = true
  }
}
