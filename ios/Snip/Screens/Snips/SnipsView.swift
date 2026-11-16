import PodcastAPI
import SwiftUI

/// Every snip, newest first, paged with the server's cursor. Tap one to open its page; swipe to delete. On the iPhone
/// Duo open and held wide, the list is the left page and the chosen snip the right, one each side of the fold: a tap
/// chooses a snip instead of pushing it, and the newest is chosen until another is. The right page is for reading:
/// starting to edit there (a tap on the title, Adjust), a second tap on the chosen row or Open pushes the snip across
/// both pages, its title and words each on a page of their own, where there is room to type. Folding or turning the
/// Duo away from wide pushes the snip that was chosen, so it stays on screen.
struct SnipsView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.horizontalSizeClass) private var horizontalSizeClass
  @Environment(\.verticalSizeClass) private var verticalSizeClass
  @State private var snips: [Snip] = []
  @State private var next: String?
  @State private var error: String?
  @State private var loading = false
  @State private var loadingMore = false
  @State private var loaded = false
  @State private var opened: SnipRoute?
  /// The snip on the right page when the list and a snip share the screen; nil chooses the newest.
  @State private var chosen: ULID?
  /// A snip chosen by something other than a tap on its row (a launch link, a delete): the list scrolls to it once it
  /// is loaded, loading further pages to find it.
  @State private var revealing: ULID?
  @State private var size = CGSize.zero

  /// The iPhone Duo open and held wide: the list beside the chosen snip.
  private var spread: Bool {
    UnfoldedDisplay.isSpread(horizontal: horizontalSizeClass, vertical: verticalSizeClass, size: size)
  }
  /// The snip on the right page: the one chosen (perhaps further down than the pages loaded so far), else the newest.
  private var shown: ULID? { chosen ?? snips.first?.id }

  var body: some View {
    // One list in either layout, so folding or turning keeps its scroll position.
    HingeSplit(split: spread, gapFill: Color(.systemGroupedBackground)) {
      // The grouped list's own margin stops at the safe area, and beside the snip its edge is the gap at the fold.
      list.contentMargins(.trailing, spread ? 20 : 0, for: .scrollContent)
    } trailing: {
      detail
    }
    // Measured without the keyboard, which a pushed page's title can raise: it must not turn the list into a spread.
    .background {
      Color.clear.ignoresSafeArea(.keyboard).onGeometryChange(for: CGSize.self) { $0.size } action: { size = $0 }
    }
    .navigationTitle("Snips")
    .toolbar {
      if spread, let id = shown {
        ToolbarItem(placement: .topBarTrailing) {
          Button { opened = SnipRoute(id: id) } label: {
            Image(systemName: "arrow.up.left.and.arrow.down.right")
          }
          .accessibilityLabel("Open across both pages")
        }
      }
    }
    .task { if !loaded { await load(more: false) } }
    // A waiting tap was sent: it is a snip now, at the top of the list.
    .onChange(of: model.waitingSnips.count) { old, new in
      if new < old { Task { await load(more: false) } }
    }
    // Folded or turned away from wide with a snip chosen: it is pushed, so it stays on screen as it did before.
    .onChange(of: spread) { was, now in
      if was, !now, opened == nil, let id = chosen { opened = SnipRoute(id: id) }
      if now { revealing = shown }
    }
    .navigationDestination(item: $opened) { route in
      SnipPage(model: model.snipPage(route.id), renaming: route.renaming, adjusting: route.adjusting, onChange: replace) {
        removed(route.id)
      }
    }
    #if DEBUG
      // `-openSnip <id>` opens that snip's page at launch (chooses it, beside the list), for scripted simulator checks.
      .task {
        if let id = UserDefaults.standard.string(forKey: "openSnip") {
          // The first layout says whether the list and the snip share the screen.
          while size == .zero { try? await Task.sleep(for: .milliseconds(20)) }
          if spread { choose(id) } else { opened = SnipRoute(id: id) }
        }
      }
    #endif
  }

  /// The chosen snip's own page, beside the list, for reading. A new page for each snip, so nothing of the last one
  /// carries over. Editing it pushes it across both pages.
  @ViewBuilder private var detail: some View {
    if let id = shown {
      SnipPage(model: model.snipPage(id), onChange: replace) { removed(id) }
        .id(id)
        .environment(\.besideList, true)
        .environment(\.openAcrossPages) { opened = $0 }
    }
  }

  private func tapped(_ snip: Snip) {
    if spread && shown != snip.id {
      chosen = snip.id
    } else {
      opened = SnipRoute(id: snip.id)
    }
  }

  /// Chooses a snip from elsewhere than its row, and brings its row into view.
  private func choose(_ id: ULID) {
    chosen = id
    revealing = id
  }

  private var list: some View {
    ScrollViewReader { proxy in
      rows
        .onChange(of: revealing) { reveal(proxy) }
        .onChange(of: snips) { reveal(proxy) }
    }
  }

  /// Scrolls the snip being revealed to the middle of the list, loading more pages (a few at most) while it isn't
  /// among those loaded.
  private func reveal(_ proxy: ScrollViewProxy) {
    guard let id = revealing, spread, loaded else { return }
    if snips.contains(where: { $0.id == id }) {
      revealing = nil
      Task { withAnimation { proxy.scrollTo(id, anchor: .center) } }
    } else if next != nil, !loading, snips.count < 300 {
      Task { await load(more: true) }
    } else if !loading {
      revealing = nil
    }
  }

  private var rows: some View {
    List {
      if let error { Text(error).foregroundStyle(.secondary) }
      // Taps made with no connection, until they are sent; a tap opens one to name it or change its length.
      if !model.waitingSnips.isEmpty {
        Section("Waiting to send") {
          ForEach(model.waitingSnips.reversed()) { pending in
            Button { model.editingWaiting = pending } label: { WaitingSnipRow(pending: pending) }
              .buttonStyle(.plain)
              .swipeActions {
                Button("Delete", systemImage: "trash", role: .destructive) { Task { await model.deleteWaiting(pending.id) } }
              }
          }
        }
      }
      ForEach(snips) { snip in
        let marked = spread && snip.id == shown
        // Beside the snip, the row is its title and one line: the right page has the episode and the show.
        Button { tapped(snip) } label: { SnipRow(snip: snip, compact: spread, marked: marked) }
          .buttonStyle(.plain)
          .listRowBackground(marked ? ChosenRowBackground() : nil)
          .accessibilityAddTraits(marked ? .isSelected : [])
          .swipeActions {
            Button("Delete", systemImage: "trash", role: .destructive) { Task { await delete(snip) } }
          }
          .onAppear { if snip.id == snips.last?.id, next != nil { Task { await load(more: true) } } }
      }
      if loading && loadingMore { ProgressView().frame(maxWidth: .infinity) }
    }
    .overlay {
      if !loaded && error == nil {
        ProgressView()
      } else if loaded && snips.isEmpty && error == nil && model.waitingSnips.isEmpty {
        ContentUnavailableView("No snips yet", systemImage: "scissors",
          description: Text("Tap the scissors in the player to save a moment."))
      }
    }
    .refreshable { await load(more: false) }
  }

  /// A snip is gone from the list. If it was the one beside the list, the next one down takes its place (the one
  /// above, if it was the last). Elsewhere nothing is chosen, so the newest stays the default when the Duo next opens.
  private func removed(_ id: ULID) {
    guard let i = snips.firstIndex(where: { $0.id == id }) else { return }
    if chosen == id || (spread && shown == id) {
      let rest = snips.indices.filter { $0 != i }
      if let next = (rest.first { $0 > i } ?? rest.last).map({ snips[$0].id }) {
        choose(next)
      } else {
        chosen = nil
      }
    }
    snips.remove(at: i)
  }

  private func delete(_ snip: Snip) async {
    removed(snip.id)
    do {
      try await model.api.deleteSnip(snip.id)
      error = nil
    } catch {
      self.error = error.localizedDescription
      await load(more: false)
    }
  }

  private func replace(_ snip: Snip) {
    if let i = snips.firstIndex(where: { $0.id == snip.id }) { snips[i] = snip }
  }

  private func load(more: Bool) async {
    guard !loading else { return }
    loading = true
    loadingMore = more
    defer { loading = false }
    if !more, !loaded, snips.isEmpty, let saved = model.api.savedSnips(limit: 30), !saved.items.isEmpty {
      (snips, next, loaded) = (saved.items, saved.next, true)
    }
    do {
      let page = try await model.api.snips(limit: 30, after: more ? next : nil)
      snips = more ? snips + page.items : page.items
      next = page.next
      error = nil
    } catch {
      self.error = error.localizedDescription
    }
    loaded = true
  }
}

extension EnvironmentValues {
  /// Beside the list, the page asks for this to edit: the snip is pushed across both pages, in the mode asked for.
  @Entry var openAcrossPages: ((SnipRoute) -> Void)? = nil
}

/// The chosen row beside the snip: a deeper tint with a thick accent bar at its leading edge, plain at arm's length.
struct ChosenRowBackground: View {
  var body: some View {
    Color.accentColor.opacity(0.22)
      .overlay(alignment: .leading) { Color.accentColor.frame(width: 8) }
  }
}

struct SnipRow: View {
  let snip: Snip
  /// Beside the chosen snip: the title larger, then one line of where, how long and when.
  var compact = false
  /// The snip on the right page.
  var marked = false

  var body: some View {
    if compact {
      VStack(alignment: .leading, spacing: 6) {
        Text(title).font(.title2.weight(marked ? .bold : .semibold)).lineLimit(3)
        HStack(spacing: 0) {
          if let rev = snip.revision {
            Text("\(Format.clock(rev.startMs)) · \(Format.duration(rev.endMs - rev.startMs)) · ").monospacedDigit()
          }
          if let status = statusLabel { Text("\(status) · ") }
          Text(Date(timeIntervalSince1970: Double(snip.capturedAt ?? snip.createdAt) / 1000), format: .relative(presentation: .named))
        }
        .font(.body).foregroundStyle(.secondary).lineLimit(1)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.vertical, 12)
      .padding(.leading, 6)
      .contentShape(.rect)
    } else {
      full
    }
  }

  private var full: some View {
    HStack(alignment: .top, spacing: 12) {
      Artwork(url: snip.imageUrl, size: 44).padding(.top, 2)
      VStack(alignment: .leading, spacing: 3) {
        Text(title).font(.body.weight(.medium)).lineLimit(2)
        Text(snip.episodeTitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
        HStack(spacing: 0) {
          if let show = snip.showTitle { Text(show).lineLimit(1) }
          if let rev = snip.revision {
            Text("\(snip.showTitle == nil ? "" : " · ")\(Format.clock(rev.startMs)) · \(Format.duration(rev.endMs - rev.startMs))")
              .monospacedDigit().fixedSize()
          }
          if let status = statusLabel { Text(" · \(status)").fixedSize() }
          Spacer(minLength: 8)
          Text(Date(timeIntervalSince1970: Double(snip.capturedAt ?? snip.createdAt) / 1000), format: .relative(presentation: .named)).fixedSize()
        }
        .font(.caption).foregroundStyle(.secondary)
      }
    }
    .padding(.vertical, 2)
  }

  private var title: String {
    snip.revision?.title ?? (snip.isPending ? "Choosing the moment…" : "Snip")
  }

  private var statusLabel: String? {
    switch snip.revision?.status {
    case .waiting: "waiting for transcript"
    case .selecting, .preparing, nil: "preparing"
    case .failed: "failed"
    default: nil
    }
  }
}
