import PlayerKit
import PodcastAPI
import SwiftUI

/// Find episodes about a topic, in any show: the server asks Exa's podcast search (which reads podcast transcripts)
/// and matches what it finds to the shows and episodes it has. A search takes about a minute and bills one Exa run, so
/// it starts only on Find episodes, never as the owner types; the same topic again within a day comes back free. Each
/// result opens the way it can: an episode we have opens in the player at the point the topic comes up, a show we have
/// opens on its page, a show from the directory opens unfollowed (manual, so browsing never bills), a YouTube video is
/// added as an episode. The rows are large, two or three to a screen.
struct TopicSearchView: View {
  @Environment(AppModel.self) private var model
  @Environment(PlayerEngine.self) private var engine
  @Binding var showPlayer: Bool
  @State private var query: String
  /// Starts a search for the given query on arrival (Find a show's "Find episodes about…" row, which is the tap).
  private let startOnAppear: Bool
  /// nil until the server has answered whether topic search is on.
  @State private var enabled: Bool?
  @State private var recent: [TopicSearch] = []
  /// The search on screen: running, completed or failed.
  @State private var search: TopicSearch?
  @State private var starting = false
  @State private var error: String?
  /// The result being opened, by its row.
  @State private var opening: Int?
  @State private var opened: Feed?
  @FocusState private var focused: Bool
  @Environment(\.horizontalSizeClass) private var horizontal
  @Environment(\.verticalSizeClass) private var vertical
  @State private var size = CGSize.zero

  init(showPlayer: Binding<Bool>, query: String = "", start: Bool = false, search: TopicSearch? = nil) {
    _showPlayer = showPlayer
    _query = State(initialValue: query)
    _search = State(initialValue: search)
    startOnAppear = start && !query.isEmpty
  }

  private var trimmed: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
  private var running: Bool { search?.status == "running" }
  private var canStart: Bool { enabled == true && trimmed.count >= 2 && !starting && !running }
  /// The button goes while the search on screen is the field's own (running or answered), so the results start
  /// higher; editing the topic brings it back.
  private var showsButton: Bool { spread || (search.map { $0.query != trimmed || $0.status == "failed" } ?? true) }
  /// The iPhone Duo open and held wide: the topic, Find episodes and the recent searches on the left page, the
  /// search on screen on the right, so no title runs across the fold.
  private var spread: Bool { UnfoldedDisplay.isSpread(horizontal: horizontal, vertical: vertical, size: size) }

  var body: some View {
    Group {
      if spread {
        HingeSplit(gapFill: Color(.systemGroupedBackground), line: false) {
          List {
            ask
            if enabled == true { idle }
          }
        } trailing: {
          List {
            if enabled == false { notSetUp } else if let search { searchSection(search) }
          }
        }
        .background(Color(.systemGroupedBackground))
      } else {
        List {
          ask
          if enabled == false {
            notSetUp
          } else if let search {
            searchSection(search)
          } else if enabled == true {
            idle
          }
        }
        .unfoldedReadableWidth()
      }
    }
    .onGeometryChange(for: CGSize.self) { $0.size } action: { size = $0 }
    .navigationTitle("Topics")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar(.hidden, for: .tabBar)
    .navigationDestination(item: $opened) { feed in
      FeedEpisodesView(feed: feed, showPlayer: $showPlayer)
    }
    .scrollDismissesKeyboard(.immediately)
    .task {
      await loadRecent()
      // The keyboard would cover the recent searches; with none, the field is what there is to do.
      if query.isEmpty, recent.isEmpty, enabled == true { focused = true }
    }
    // While a search runs, ask again every three seconds; the server asks Exa at most that often.
    .task(id: running ? search?.id : nil) {
      guard let id = search?.id, running else { return }
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(3))
        guard !Task.isCancelled else { return }
        do {
          let now = try await model.api.topicSearch(id)
          guard search?.id == id else { return }
          search = now
          error = nil
          if now.status != "running" {
            // Not in this task: the change of status just cancelled it, and the list's request with it.
            Task { await loadRecent() }
            return
          }
        } catch {
          guard !Task.isCancelled else { return }
          self.error = error.localizedDescription
        }
      }
    }
    // Back from a show opened from a row: what it matches may have changed.
    .onChange(of: opened) { _, now in
      if now == nil, let id = search?.id { Task { if let s = try? await model.api.topicSearch(id) { search = s } } }
    }
  }

  private var notSetUp: some View {
    Text("Not set up").font(.title2.bold()).accessibilityHint("The server needs an Exa API key")
  }

  /// The topic, Find episodes, and what went wrong reaching the server.
  @ViewBuilder private var ask: some View {
    Section {
      field
      if showsButton {
        Button(action: start) {
          HStack(spacing: 10) {
            if starting { ProgressView().tint(.white) }
            Text("Find episodes")
          }
          .font(.title3.bold())
          .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.borderedProminent)
        .disabled(!canStart)
        .listRowSeparator(.hidden)
      }
    }
    if let error {
      Text(error).font(.title3).foregroundStyle(.red)
    }
  }

  /// The topic, in large type; Return starts the search, as Find episodes does.
  private var field: some View {
    HStack(spacing: 10) {
      Image(systemName: "text.magnifyingglass").foregroundStyle(.secondary).accessibilityHidden(true)
      // Wraps rather than cutting the topic short at large text sizes. A multi-line field takes Return as a new line,
      // so a new line is taken out and starts the search instead, as Find episodes does.
      TextField("Topic", text: $query, axis: .vertical)
        .lineLimit(1...4)
        .focused($focused)
        .submitLabel(.search)
        .onChange(of: query) { _, now in
          guard now.contains("\n") else { return }
          query = now.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
          start()
        }
      if !query.isEmpty {
        Button {
          query = ""
          focused = true
        } label: {
          Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Clear")
      }
    }
    .font(.title2)
    .padding(.vertical, 6)
  }

  @ViewBuilder private var idle: some View {
    if !recent.isEmpty {
      Section {
        // Two or three rows, not a long list: the newest searches are the ones come back to.
        ForEach(recent.prefix(3)) { s in
          Button {
            focused = false
            query = s.query
            search = s
            error = nil
          } label: {
            RecentRow(search: s)
          }
          .buttonStyle(.plain)
        }
      } header: {
        Text("Recent").font(.title3.bold()).textCase(nil).foregroundStyle(.primary)
      }
    }
  }

  @ViewBuilder private func searchSection(_ s: TopicSearch) -> some View {
    switch s.status {
    case "running":
      HStack(spacing: 16) {
        ProgressView().controlSize(.large)
        Text("Searching").font(.title2.bold())
      }
      .padding(.vertical, 8)
      .accessibilityElement(children: .combine)
    case "failed":
      // Exa's reason goes to VoiceOver only: it is a sentence, and Find episodes is the way on either way.
      Text("Search failed").font(.title2.bold()).padding(.vertical, 8).accessibilityHint(s.error ?? "")
    default:
      if s.results.isEmpty {
        Text("No episodes").font(.title2.bold()).padding(.vertical, 8)
      } else {
        Section {
          ForEach(Array(s.results.enumerated()), id: \.offset) { index, result in
            // Nothing to open: shown at full contrast, not as a dimmed button.
            if result.match == "none" {
              TopicResultRow(result: result, opening: false)
            } else {
              Button {
                open(result, index: index)
              } label: {
                TopicResultRow(result: result, opening: opening == index)
              }
              .buttonStyle(.plain)
              .disabled(opening != nil)
            }
          }
        } header: {
          // The field above says the topic already, unless it has been edited since.
          if s.query != trimmed {
            Text(s.query).font(.title3.bold()).textCase(nil).foregroundStyle(.primary)
          }
        }
      }
    }
  }

  private func loadRecent() async {
    do {
      let list = try await model.api.topicSearches(limit: 10)
      enabled = list.enabled
      recent = list.items.filter { $0.status != "failed" }
      if startOnAppear, search == nil, !starting, list.enabled { start() }
    } catch {
      guard !Task.isCancelled, (error as? URLError)?.code != .cancelled else { return }
      self.error = error.localizedDescription
    }
  }

  private func start() {
    guard canStart else { return }
    focused = false
    starting = true
    let body = StartTopicSearch(query: trimmed, clientRequestId: UUID().uuidString.lowercased())
    Task {
      defer { starting = false }
      do {
        search = try await model.api.startTopicSearch(body)
        error = nil
      } catch let e as APIError where e.status == 409 {
        enabled = false
      } catch {
        self.error = error.localizedDescription
      }
    }
  }

  private func open(_ r: TopicSearch.Result, index: Int) {
    switch r.match {
    case "episode":
      guard let episode = r.episode else { return }
      let task = engine.open(episode.id)
      showPlayer = true
      // To where the topic comes up, a little early: the search's transcript is not ours, so its times are approximate.
      if let start = r.startMs, start > 0 {
        Task {
          await task?.value
          if engine.episode?.id == episode.id { engine.seek(to: max(0, start - 5_000)) }
        }
      }
    case "show":
      guard let id = r.feedId else { return }
      run(index) { opened = try await model.api.feed(id) }
    case "new_show":
      guard let show = r.show else { return }
      run(index) {
        do {
          opened = try await model.api.createFeed(CreateFeed(url: show.feedUrl, followed: false))
        } catch let e as APIError where e.status == 409 {
          guard let id = e.feedId else { throw e }
          opened = try await model.api.feed(id)
        }
      }
    case "video":
      guard let url = r.url else { return }
      run(index) {
        let episode = try await model.api.addYouTubeVideo(url)
        engine.open(episode.id)
        showPlayer = true
      }
    default:
      break
    }
  }

  private func run(_ index: Int, _ work: @escaping () async throws -> Void) {
    opening = index
    Task {
      defer { opening = nil }
      do {
        try await work()
        error = nil
      } catch {
        self.error = error.localizedDescription
      }
    }
  }
}

/// One episode found: the show's name, the episode's title in large bold type, what it says about the topic, and what a
/// tap does. Text wraps rather than cutting off; two or three rows fill the screen.
private struct TopicResultRow: View {
  let result: TopicSearch.Result
  let opening: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(result.podcast)
        .font(.headline)
        .foregroundStyle(.secondary)
        .lineLimit(2)
      Text(result.title)
        .font(.title2.bold())
        .lineLimit(4)
        .fixedSize(horizontal: false, vertical: true)
      if let why = result.why {
        Text(why)
          .font(.title3)
          .lineLimit(3)
          .fixedSize(horizontal: false, vertical: true)
      }
      action
        .font(.title3.weight(.semibold))
        .padding(.top, 2)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.vertical, 10)
    .contentShape(.rect)
    .accessibilityElement(children: .combine)
    .accessibilityValue(opening ? "Opening" : "")
  }

  @ViewBuilder private var action: some View {
    HStack(spacing: 8) {
      if opening {
        ProgressView()
      } else {
        Image(systemName: symbol).accessibilityHidden(true)
      }
      Text(label).fixedSize(horizontal: false, vertical: true)
    }
    .foregroundStyle(result.match == "none" ? AnyShapeStyle(.secondary) : AnyShapeStyle(.tint))
  }

  private var symbol: String {
    switch result.match {
    case "episode": "play.circle.fill"
    case "show": "rectangle.stack"
    case "new_show": "plus.circle"
    case "video": "play.rectangle"
    default: "questionmark.circle"
    }
  }

  private var label: String {
    switch result.match {
    case "episode":
      if let ms = result.startMs, ms > 0 { "Play from \(clock(ms))" } else { "Play" }
    case "show": "Open show"
    case "new_show": "New show"
    case "video": "Add video"
    default: "Not found"
    }
  }

  private func clock(_ ms: Int) -> String {
    let s = ms / 1000
    return s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60) : String(format: "%d:%02d", s / 60, s % 60)
  }
}

/// A search run before: its topic, in large type.
private struct RecentRow: View {
  let search: TopicSearch

  var body: some View {
    Text(search.query)
      .font(.title2.bold())
      .lineLimit(3)
      .fixedSize(horizontal: false, vertical: true)
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.vertical, 8)
    .contentShape(.rect)
    .accessibilityElement(children: .combine)
  }
}
