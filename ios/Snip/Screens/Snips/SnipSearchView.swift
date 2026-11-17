import PodcastAPI
import SwiftUI

/// Find a snip by what it says: the server matches the words typed against every snip's title, summary, clip words
/// and note. One large field, then the snips found, newest first, each its cover, its title large and its show. A tap
/// opens the snip's page. On the iPhone Duo open and held wide, the field and what it found are the left page and the
/// chosen snip the right (the first found until another is chosen); a snip there opens across both pages to edit.
struct SnipSearchView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.horizontalSizeClass) private var horizontalSizeClass
  @Environment(\.verticalSizeClass) private var verticalSizeClass
  @State private var query: String
  @State private var found: [Snip]?
  @State private var error: String?
  @State private var opened: SnipRoute?
  @State private var chosen: ULID?
  @State private var size = CGSize.zero
  @FocusState private var focused: Bool
  @ScaledMetric(relativeTo: .title) private var coverSize: CGFloat = 64

  init(query: String = "") {
    _query = State(initialValue: query)
  }

  private var trimmed: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
  private var spread: Bool { UnfoldedDisplay.isSpread(horizontal: horizontalSizeClass, vertical: verticalSizeClass, size: size) }
  /// The snip on the right page when held wide: the one chosen, else the first found.
  private var shown: Snip? { found?.first { $0.id == chosen } ?? found?.first }

  var body: some View {
    HingeSplit(split: spread, gapFill: Color(.systemBackground)) {
      VStack(spacing: 0) {
        field
          .padding(.horizontal, 20)
          .padding(.top, 4)
          .padding(.bottom, 8)
        results.contentMargins(.trailing, spread ? 8 : 0, for: .scrollContent)
      }
    } trailing: {
      if let snip = shown {
        // A new page for each snip, so nothing of the last one carries over.
        SnipPage(model: model.snipPage(snip.id), onChange: replace)
          .id(snip.id)
          .environment(\.besideList, true)
          .environment(\.openAcrossPages) { opened = $0 }
      }
    }
    .background {
      Color.clear.ignoresSafeArea(.keyboard).onGeometryChange(for: CGSize.self) { $0.size } action: { size = $0 }
    }
    .navigationTitle("Search")
    .navigationBarTitleDisplayMode(.inline)
    // A pushed page of its own: the floating tab bar would sit over a result.
    .toolbar(.hidden, for: .tabBar)
    .navigationDestination(item: $opened) { route in
      SnipPage(model: model.snipPage(route.id), renaming: route.renaming, adjusting: route.adjusting, onChange: replace) {
        found?.removeAll { $0.id == route.id }
      }
    }
    // Folded or turned away from wide with a snip chosen: it is pushed, so it stays on screen.
    .onChange(of: spread) { was, now in
      if was, !now, opened == nil, chosen != nil, let snip = shown { opened = SnipRoute(id: snip.id) }
    }
    .onAppear { if query.isEmpty { focused = true } }
    // Debounced: each keystroke cancels the previous wait.
    .task(id: trimmed) {
      try? await Task.sleep(for: .milliseconds(350))
      guard !Task.isCancelled else { return }
      await search()
    }
  }

  private var field: some View {
    HStack(spacing: 12) {
      Image(systemName: "magnifyingglass").foregroundStyle(.secondary).accessibilityHidden(true)
      TextField("Search snips", text: $query)
        .focused($focused)
        .submitLabel(.search)
        .autocorrectionDisabled()
        .onSubmit { focused = false }
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
    .font(.title2.weight(.semibold))
    .padding(.horizontal, 18)
    .frame(minHeight: 60)
    .background(Color(.secondarySystemFill), in: .capsule)
  }

  private var results: some View {
    List {
      if let error { Text(error).font(.body).foregroundStyle(.secondary) }
      ForEach(found ?? []) { snip in
        let marked = spread && snip.id == shown?.id
        Button { tapped(snip) } label: { row(snip, marked: marked) }
          .buttonStyle(.plain)
          .listRowBackground(marked ? ChosenRowBackground() : nil)
          .accessibilityAddTraits(marked ? .isSelected : [])
      }
    }
    .listStyle(.plain)
    .scrollDismissesKeyboard(.immediately)
    .overlay {
      if trimmed.count >= 2, found == nil, error == nil {
        ProgressView()
      } else if trimmed.count >= 2, found?.isEmpty == true {
        ContentUnavailableView("No snips found", systemImage: "magnifyingglass")
      }
    }
  }

  private func row(_ snip: Snip, marked: Bool) -> some View {
    HStack(alignment: .top, spacing: 16) {
      Artwork(url: snip.imageUrl, size: coverSize)
      VStack(alignment: .leading, spacing: 6) {
        Text(snip.revision?.title ?? (snip.isPending ? "Choosing the moment…" : "Snip"))
          .font(.title2.weight(.bold)).lineLimit(3).multilineTextAlignment(.leading)
        if let show = snip.showTitle {
          Text(show).font(.body).foregroundStyle(.secondary).lineLimit(1)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(.vertical, 10)
    .padding(.leading, marked ? 6 : 0)
    .contentShape(.rect)
  }

  private func tapped(_ snip: Snip) {
    focused = false
    if spread && shown?.id != snip.id {
      chosen = snip.id
    } else {
      opened = SnipRoute(id: snip.id)
    }
  }

  private func replace(_ snip: Snip) {
    if let i = found?.firstIndex(where: { $0.id == snip.id }) { found?[i] = snip }
  }

  private func search() async {
    let text = trimmed
    guard text.count >= 2 else {
      (found, error, chosen) = (nil, nil, nil)
      return
    }
    found = nil
    do {
      let page = try await model.api.snips(search: text, limit: 50)
      // Typed on meanwhile: that search's answer is the one to show.
      guard text == trimmed else { return }
      (found, error, chosen) = (page.items, nil, nil)
    } catch {
      guard text == trimmed else { return }
      self.error = error.localizedDescription
      found = []
    }
  }
}
