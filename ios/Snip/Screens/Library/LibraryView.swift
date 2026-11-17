import PodcastAPI
import SwiftUI

/// The shows (podcast feeds). A text feed is the publisher's articles for a show, so it is listed as a tag on
/// that show rather than on its own, like the web Library. On the iPhone Duo open and held wide, the shows are the left
/// page and the chosen show's episodes the right, one each side of the fold; the first show is chosen until another is.
/// Folding or turning the Duo away from wide pushes the show that was chosen, so it stays on screen.
struct LibraryView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.horizontalSizeClass) private var horizontalSizeClass
  @Environment(\.verticalSizeClass) private var verticalSizeClass
  @Binding var showPlayer: Bool
  @State private var feeds: [Feed] = []
  @State private var error: String?
  @State private var loaded = false
  @State private var searching = false
  @State private var searchText = ""
  /// Topic search (TopicSearchView): episodes about a topic, in any show.
  @State private var findingTopic = false
  /// DEBUG `-startTopic 1`: the topic search opened by `-searchTopic` starts at once, so each of its states can be
  /// reached by a launch alone.
  @State private var startTopic = false
  /// A show opened by something other than a row (the DEBUG `-openFeed` launch argument).
  @State private var opened: Feed?
  /// The show on the right page when the shows and one show's episodes share the screen; nil chooses the first.
  @State private var chosen: ULID?
  @State private var size = CGSize.zero

  /// The iPhone Duo open and held wide: the shows beside the chosen one's episodes.
  private var spread: Bool {
    UnfoldedDisplay.isSpread(horizontal: horizontalSizeClass, vertical: verticalSizeClass, size: size)
  }
  /// The show on the right page: the one chosen, else the first. A show unfollowed on the right page leaves the list
  /// but stays on that page, where Follow undoes it, until another is chosen.
  private var shown: Feed? { feeds.first { $0.id == chosen } ?? shows.first }

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
    // One list in either layout, so folding or turning keeps its scroll position.
    HingeSplit(split: spread, gapFill: Color(.systemGroupedBackground), line: false) {
      // The grouped list's own margin stops at the safe area, and beside the show its edge is the gap at the fold.
      list.contentMargins(.trailing, spread ? 20 : 0, for: .scrollContent)
    } trailing: {
      if let feed = shown {
        // A new page for each show, so nothing of the last one carries over.
        FeedEpisodesView(feed: feed, showPlayer: $showPlayer)
          .contentMargins(.leading, 20, for: .scrollContent)
          .id(feed.id)
          .environment(\.besideList, true)
      }
    }
    .background {
      Color.clear.ignoresSafeArea(.keyboard).onGeometryChange(for: CGSize.self) { $0.size } action: { size = $0 }
    }
    // Folded or turned away from wide with a show chosen: it is pushed, so it stays on screen.
    .onChange(of: spread) { was, now in
      if was, !now, opened == nil, chosen != nil, let feed = shown { opened = feed }
    }
    // A show followed or unfollowed on the right page (which never leaves the screen there) changes the list now.
    // The show on the right page is held there (chosen), so leaving the list doesn't swap it for the next one.
    .onChange(of: model.unfollowedFeeds) {
      guard spread else { return }
      if chosen == nil, let id = shown?.id, model.unfollowedFeeds.contains(id) { chosen = id }
      Task { await load() }
    }
    .navigationTitle("Library")
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button {
          searchText = ""
          startTopic = false
          findingTopic = true
        } label: {
          // A word, not a second magnifying glass beside Find a show's.
          Text("Topics").font(.body.weight(.semibold)).accessibilityLabel("Find episodes about a topic")
        }
      }
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
    .navigationDestination(isPresented: $findingTopic) {
      TopicSearchView(showPlayer: $showPlayer, query: searchText, start: startTopic)
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

  private var list: some View {
    List {
      if let error {
        Text(error).foregroundStyle(.secondary)
      }
      MediaFilter.picker($mediaFilter)
      ForEach(shows) { feed in
        if spread {
          let marked = feed.id == shown?.id
          Button { chosen = feed.id } label: {
            row(feed, marked: marked).padding(.leading, 6).frame(maxWidth: .infinity, alignment: .leading).contentShape(.rect)
          }
            .buttonStyle(.plain)
            .listRowBackground(marked ? ChosenRowBackground() : nil)
            .accessibilityAddTraits(marked ? .isSelected : [])
        } else {
          NavigationLink(value: feed) { row(feed) }
        }
      }
    }
    .overlay { if !loaded && error == nil { ProgressView() } }
  }

  private func row(_ feed: Feed, marked: Bool = false) -> some View {
    HStack(spacing: 12) {
      Artwork(url: feed.imageUrl, size: 52)
      VStack(alignment: .leading, spacing: 3) {
        Text(feed.title ?? "Untitled show").font(.body.weight(marked ? .bold : .medium)).lineLimit(2)
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

  private func detail(for feed: Feed) -> String {
    [
      feed.episodeCount == 1 ? "1 episode" : "\(feed.episodeCount) episodes",
      feed.kind == "youtube" ? "YouTube" : feed.kind == "links" ? "One-offs" : nil,
      showsWithText.contains(feed.id) ? "Publisher text" : nil,
      feed.autoProcess ? nil : "Manual",
    ].compactMap { $0 }.joined(separator: " · ")
  }

  #if DEBUG
    /// `-searchShows <text>` opens show search with that text; `-searchTopic <text>` opens topic search with that
    /// text (started only with `-startTopic 1`); `-openFeed <id>` opens that show. For scripted simulator checks, once per launch.
    private func openFromLaunchArguments() async {
      guard !Self.launchArgumentsUsed else { return }
      Self.launchArgumentsUsed = true
      if let text = UserDefaults.standard.string(forKey: "searchShows") {
        searchText = text
        searching = true
      } else if let text = UserDefaults.standard.string(forKey: "searchTopic") {
        searchText = text
        startTopic = UserDefaults.standard.bool(forKey: "startTopic")
        findingTopic = true
      } else if let id = UserDefaults.standard.string(forKey: "openFeed") {
        // The first layout says whether the shows and a show share the screen.
        while size == .zero { try? await Task.sleep(for: .milliseconds(20)) }
        if spread { chosen = id } else { opened = try? await model.api.feed(id) }
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
