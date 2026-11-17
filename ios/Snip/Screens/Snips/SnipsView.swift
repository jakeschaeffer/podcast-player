import PodcastAPI
import SwiftUI
import SyncKit

/// The episodes snipped from, the one snipped from most recently first: each its cover, its title large and one line
/// with the show and how many snips. One button at the top keeps a single show's. A tap opens the episode's snips
/// (EpisodeSnipsPage), with Share all at its top; a tap there opens a snip's page. Taps made with no connection count
/// on their episode's row ("1 not sent") until they are sent, and an episode that has nothing else yet shows by them
/// alone.
///
/// On the iPhone Duo open and held wide, the episodes are the left page and the chosen one's snips the right, one each
/// side of the fold, as the Library sets a show beside its episodes: a tap chooses an episode instead of pushing it,
/// and the newest is chosen until another is. A snip opens across both pages. Folding or turning the Duo away from
/// wide pushes the episode that was chosen, so it stays on screen.
struct SnipsView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.horizontalSizeClass) private var horizontalSizeClass
  @Environment(\.verticalSizeClass) private var verticalSizeClass
  @State private var episodes: [SnipEpisode] = []
  @State private var next: String?
  @State private var error: String?
  @State private var loading = false
  @State private var loaded = false
  @State private var reloadWanted = false
  /// One show's episodes only; nil for all of them.
  @State private var show: SnipShow?
  @State private var shows: [SnipShow] = []
  @State private var choosingShow = false
  /// Search pushed over the list, with the words it starts from (a launch link's).
  @State private var searching = false
  @State private var searchText = ""
  /// An episode's snips pushed over the list.
  @State private var opened: SnipsEpisode?
  /// A snip's page over the list: opened from the episode beside it, or by a launch link.
  @State private var openedSnip: SnipRoute?
  /// The episode on the right page when the list and an episode share the screen; nil chooses the newest.
  @State private var chosen: ULID?
  @State private var size = CGSize.zero
  @ScaledMetric(relativeTo: .title2) private var coverSize: CGFloat = 80

  /// The iPhone Duo open and held wide: the episodes beside the chosen one's snips.
  private var unfolded: Bool { UnfoldedDisplay.isUnfolded(horizontal: horizontalSizeClass, vertical: verticalSizeClass) }

  private var spread: Bool {
    UnfoldedDisplay.isSpread(horizontal: horizontalSizeClass, vertical: verticalSizeClass, size: size)
  }

  /// The server's episodes with the taps still on the phone counted in, and an episode of the filter's show that has
  /// only waiting taps so far put in by when they were made.
  private var rows: [Row] {
    let waiting = Dictionary(grouping: model.waitingSnips.filter { matchesFilter($0) }, by: \.episodeID)
    var rows = episodes.map {
      let taps = waiting[$0.episodeId] ?? []
      return Row(episode: SnipsEpisode($0), count: $0.snipCount, waiting: taps.count, at: max($0.lastSnippedAt, taps.map(\.body.capturedAt).max() ?? 0))
    }
    let listed = Set(episodes.map(\.episodeId))
    for (id, taps) in waiting where !listed.contains(id) {
      guard let tap = taps.max(by: { $0.body.capturedAt < $1.body.capturedAt }) else { continue }
      let episode = SnipsEpisode(id: id, title: tap.episodeTitle ?? "Episode", showTitle: tap.showTitle, imageUrl: tap.imageUrl)
      rows.append(Row(episode: episode, count: 0, waiting: taps.count, at: tap.body.capturedAt))
    }
    // The newest snip, or waiting tap, first.
    return rows.sorted { $0.at > $1.at }
  }

  /// The episode on the right page: the one chosen, else the newest.
  private var shown: SnipsEpisode? {
    let all = rows
    return all.first { $0.episode.id == chosen }?.episode ?? all.first?.episode
  }

  var body: some View {
    // One list in either layout, so folding or turning keeps its scroll position.
    HingeSplit(split: spread, gapFill: Color(.systemGroupedBackground)) {
      // Beside the episode, the list's edge is the gap at the fold.
      list.contentMargins(.trailing, spread ? 8 : 0, for: .scrollContent)
    } trailing: {
      if let episode = shown {
        // A new page for each episode, so nothing of the last one carries over.
        // Its snips open across both pages from here, so folding the Duo keeps one that is open (the right page goes).
        EpisodeSnipsPage(episode: episode) { Task { await load() } }
          .id(episode.id)
          .environment(\.openAcrossPages) { openedSnip = $0 }
      }
    }
    // Measured without the keyboard, which a pushed page's title can raise: it must not turn the list into a spread.
    .background {
      Color.clear.ignoresSafeArea(.keyboard).onGeometryChange(for: CGSize.self) { $0.size } action: { size = $0 }
    }
    .navigationTitle("Snips")
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button {
          searchText = ""
          searching = true
        } label: {
          Image(systemName: "magnifyingglass")
        }
        .accessibilityLabel("Search snips")
      }
    }
    .navigationDestination(isPresented: $searching) { SnipSearchView(query: searchText) }
    .task { if !loaded { await load() } }
    // A waiting tap was sent: it is a snip now, on its episode's row.
    .onChange(of: model.waitingSnips.count) { old, new in
      if new < old { Task { await load() } }
    }
    // Folded or turned away from wide with an episode chosen: it is pushed, so it stays on screen. Not over a snip
    // opened from it, which stays in front (back from it is the list).
    .onChange(of: spread) { was, now in
      if was, !now, opened == nil, openedSnip == nil, chosen != nil, let episode = shown { opened = episode }
    }
    // Another show's list: start from what the phone saved for it, then ask the server.
    .onChange(of: show) {
      (episodes, next, loaded) = ([], nil, false)
      Task { await load() }
    }
    .navigationDestination(item: $opened) { episode in
      EpisodeSnipsPage(episode: episode) { Task { await load() } }
    }
    .navigationDestination(item: $openedSnip) { route in
      SnipPage(model: model.snipPage(route.id), renaming: route.renaming, adjusting: route.adjusting) { _ in } onDelete: {
        Task { await load() }
      }
    }
    // A sheet on the phone; the whole screen on the open Duo, where a sheet floats as a card across the fold.
    .sheet(isPresented: Binding(get: { choosingShow && !unfolded }, set: { if !$0, !unfolded { choosingShow = false } })) { showPicker }
    .fullScreenCover(isPresented: Binding(get: { choosingShow && unfolded }, set: { if !$0, unfolded { choosingShow = false } })) {
      showPicker.unfoldedTypeScale().unfoldedReadableWidth()
    }
    #if DEBUG
      // `-openSnip <id>` opens that snip's page at launch; `-openSnipsEpisode <id>` that episode's snips (chosen,
      // beside the list, when they share the screen); `-searchSnips <text>` search with those words. For scripted
      // simulator checks.
      .task {
        // Once per launch: the list appears again each time a page pushed over it is closed.
        guard !Self.launchArgumentsUsed else { return }
        Self.launchArgumentsUsed = true
        let defaults = UserDefaults.standard
        if let id = defaults.string(forKey: "openSnip") {
          openedSnip = SnipRoute(id: id)
        } else if let text = defaults.string(forKey: "searchSnips") {
          searchText = text
          searching = true
        } else if let id = defaults.string(forKey: "openSnipsEpisode") {
          // The first layout says whether the list and an episode share the screen.
          while size == .zero || !loaded { try? await Task.sleep(for: .milliseconds(20)) }
          if spread {
            chosen = id
          } else if let row = rows.first(where: { $0.episode.id == id }) {
            opened = row.episode
          }
        }
        if defaults.bool(forKey: "chooseSnipsShow") { choosingShow = true }
      }
    #endif
  }

  #if DEBUG
    @MainActor private static var launchArgumentsUsed = false
  #endif

  // MARK: The list

  private var list: some View {
    List {
      filterButton
        .listRowSeparator(.hidden)
        .listRowInsets(EdgeInsets(top: 4, leading: 20, bottom: 8, trailing: 20))
      if let error { Text(error).font(.body).foregroundStyle(.secondary) }
      ForEach(rows) { row in
        let marked = spread && row.episode.id == shown?.id
        Button { tapped(row.episode) } label: { episodeRow(row, marked: marked) }
          .buttonStyle(.plain)
          .listRowBackground(marked ? ChosenRowBackground() : nil)
          .accessibilityAddTraits(marked ? .isSelected : [])
          .onAppear { if row.episode.id == episodes.last?.episodeId, next != nil { Task { await load(more: true) } } }
      }
      if loading && next != nil { ProgressView().frame(maxWidth: .infinity) }
    }
    .listStyle(.plain)
    .overlay {
      if !loaded && error == nil {
        ProgressView()
      } else if loaded && rows.isEmpty && error == nil {
        ContentUnavailableView(
          show == nil ? "No snips yet" : "No snips from this show", systemImage: "scissors",
          description: Text(show == nil ? "Tap the scissors in the player to save a moment." : ""))
      }
    }
    .refreshable { await load() }
  }

  /// All shows, or the one kept: a tap opens the list of shows to choose from.
  private var filterButton: some View {
    Button { choosingShow = true } label: {
      HStack(spacing: 12) {
        Text(show.map { $0.title ?? "Untitled show" } ?? "All shows").lineLimit(1)
        Spacer(minLength: 8)
        Image(systemName: "chevron.down").font(.body.weight(.bold)).foregroundStyle(.secondary)
      }
      .font(.title3.weight(.bold))
      .padding(.horizontal, 20)
      .frame(maxWidth: .infinity, minHeight: 56)
      .background(Color(.secondarySystemFill), in: .capsule)
      .contentShape(.capsule)
    }
    .buttonStyle(.plain)
    .accessibilityLabel(show.map { "Showing \($0.title ?? "one show"). Choose a show" } ?? "All shows. Choose a show")
  }

  private func episodeRow(_ row: Row, marked: Bool) -> some View {
    HStack(alignment: .top, spacing: 16) {
      Artwork(url: row.episode.imageUrl, size: coverSize)
      VStack(alignment: .leading, spacing: 6) {
        Text(row.episode.title)
          .font(.title2.weight(.bold))
          .lineLimit(3).multilineTextAlignment(.leading)
        // The show gives way first: the count and anything not sent always show whole.
        HStack(spacing: 0) {
          // Under a show's filter, the button above already says the show.
          if show == nil, let show = row.episode.showTitle {
            Text(show).lineLimit(1)
            if row.count > 0 || row.waiting > 0 { Text(" · ").fixedSize() }
          }
          if row.count > 0 { Text(row.count == 1 ? "1 snip" : "\(row.count) snips").fixedSize() }
          if row.waiting > 0 {
            Text("\(row.count > 0 ? " · " : "")\(row.waiting) not sent").bold().foregroundStyle(Color.accentColor).fixedSize()
          }
        }
        .font(.body).foregroundStyle(.secondary)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(.vertical, 10)
    .padding(.leading, marked ? 6 : 0)
    .contentShape(.rect)
  }

  private func tapped(_ episode: SnipsEpisode) {
    if spread {
      chosen = episode.id
    } else {
      opened = episode
    }
  }

  // MARK: Choosing a show

  private var showPicker: some View {
    NavigationStack {
      List {
        showChoice(nil)
        ForEach(shows) { showChoice($0) }
      }
      .listStyle(.plain)
      .navigationTitle("Show")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Done") { choosingShow = false } }
      }
    }
    .task { await loadShows() }
  }

  private func showChoice(_ choice: SnipShow?) -> some View {
    Button {
      show = choice
      chosen = nil
      choosingShow = false
    } label: {
      HStack(spacing: 14) {
        if let choice {
          Artwork(url: choice.imageUrl, size: 56)
        } else {
          Image(systemName: "square.stack").font(.title2).frame(width: 56, height: 56)
            .background(Color(.secondarySystemFill), in: .rect(cornerRadius: 7))
        }
        Text(choice.map { $0.title ?? "Untitled show" } ?? "All shows").font(.title3.weight(.semibold)).lineLimit(2)
        Spacer(minLength: 8)
        if choice?.feedId == show?.feedId {
          Image(systemName: "checkmark").font(.title3.weight(.bold)).foregroundStyle(Color.accentColor)
        }
      }
      .padding(.vertical, 6)
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(choice?.feedId == show?.feedId ? .isSelected : [])
  }

  // MARK: Loading

  /// A waiting tap belongs under the filter when its show's name is the one kept (a tap knows its show only by name).
  private func matchesFilter(_ tap: SnipOutbox.Pending) -> Bool {
    guard let show else { return true }
    return tap.showTitle != nil && tap.showTitle == show.title
  }

  /// One load at a time. A fresh load asked for meanwhile (another show chosen, a snip sent) runs as soon as this
  /// one ends, so the list always ends up as the latest ask wanted.
  private func load(more: Bool = false) async {
    guard !loading else {
      if !more { reloadWanted = true }
      return
    }
    loading = true
    let feed = show?.feedId
    defer {
      loading = false
      if reloadWanted {
        reloadWanted = false
        Task { await load() }
      }
    }
    if !more, !loaded || episodes.isEmpty, let saved = model.api.savedSnipEpisodes(feedID: feed) {
      (episodes, next, loaded) = (saved.items, saved.next, true)
    }
    do {
      let page = try await model.api.snipEpisodes(feedID: feed, after: more ? next : nil)
      // Another show was chosen while this was on its way: its load follows this one.
      guard feed == show?.feedId else {
        reloadWanted = true
        return
      }
      episodes = more ? episodes + page.items.filter { item in !episodes.contains { $0.episodeId == item.episodeId } } : page.items
      next = page.next
      error = nil
    } catch {
      self.error = error.localizedDescription
    }
    loaded = true
  }

  private func loadShows() async {
    if shows.isEmpty, let saved = model.api.savedSnipShows() { shows = saved }
    if let fresh = try? await model.api.snipShows() { shows = fresh }
  }

  struct Row: Identifiable {
    let episode: SnipsEpisode
    /// Snips the server has.
    let count: Int
    /// Taps still on the phone.
    let waiting: Int
    /// When the newest of them was made.
    let at: Int
    var id: ULID { episode.id }
  }
}

extension EnvironmentValues {
  /// Beside a list, a snip's page asks for this to edit: the snip is pushed across both pages, in the mode asked for.
  @Entry var openAcrossPages: ((SnipRoute) -> Void)? = nil
}

/// The chosen row beside its page: a deeper tint with a thick accent bar at its leading edge, plain at arm's length.
struct ChosenRowBackground: View {
  var body: some View {
    Color.accentColor.opacity(0.22)
      .overlay(alignment: .leading) { Color.accentColor.frame(width: 8) }
  }
}
