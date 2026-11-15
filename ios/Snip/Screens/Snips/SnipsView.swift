import PodcastAPI
import SwiftUI

/// Every snip, newest first, paged with the server's cursor. Tap one to open its page; swipe to delete. On the iPhone
/// Duo open and held wide, the list is the left page and the chosen snip's page the right, one each side of the fold:
/// a tap chooses a snip instead of pushing it, the newest is chosen until another is, and Open (or a second tap on the
/// chosen row) pushes it across both pages.
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
  @State private var size = CGSize.zero
  /// The snip beside the list is being edited: the list waits, so a tap on another snip can't drop the edit.
  @State private var editingBeside = false

  /// The iPhone Duo open and held wide: the list beside the chosen snip.
  private var spread: Bool {
    UnfoldedDisplay.isSpread(horizontal: horizontalSizeClass, vertical: verticalSizeClass, size: size)
  }
  /// The snip on the right page: the one chosen (perhaps further down than the pages loaded so far), else the newest.
  private var shown: ULID? { chosen ?? snips.first?.id }

  var body: some View {
    Group {
      if spread {
        HingeSplit {
          // The grouped list's own margin stops at the safe area, and here its edge is the gap at the fold.
          list.contentMargins(.trailing, 20, for: .scrollContent)
            .disabled(editingBeside)
        } trailing: {
          detail.onPreferenceChange(SnipEditingKey.self) { editingBeside = $0 }
        }
      } else {
        list.unfoldedReadableWidth()
      }
    }
    .onGeometryChange(for: CGSize.self) { $0.size } action: { size = $0 }
    .navigationTitle("Snips")
    .toolbar {
      if spread, !editingBeside, let id = shown {
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
    .navigationDestination(item: $opened) { route in
      SnipPage(snipID: route.id, api: model.api, onChange: replace) {
        removed(route.id)
      }
    }
    #if DEBUG
      // `-openSnip <id>` opens that snip's page at launch (chooses it, beside the list), for scripted simulator checks.
      .task {
        if let id = UserDefaults.standard.string(forKey: "openSnip") {
          // The first layout, which says whether the list and the snip share the screen, can come after this.
          for _ in 0..<20 where !spread { try? await Task.sleep(for: .milliseconds(50)) }
          if spread { chosen = id } else { opened = SnipRoute(id: id) }
        }
      }
    #endif
  }

  /// The chosen snip's own page, beside the list. A new page for each snip, so nothing of the last one carries over.
  @ViewBuilder private var detail: some View {
    if let id = shown {
      SnipPage(snipID: id, api: model.api, onChange: replace) { removed(id) }
        .id(id)
        .environment(\.besideList, true)
    }
  }

  private func tapped(_ snip: Snip) {
    if spread && shown != snip.id {
      chosen = snip.id
    } else {
      opened = SnipRoute(id: snip.id)
    }
  }

  private var list: some View {
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
        Button { tapped(snip) } label: { SnipRow(snip: snip) }
          .buttonStyle(.plain)
          .listRowBackground(marked ? Color.accentColor.opacity(0.3) : nil)
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
  /// above, if it was the last).
  private func removed(_ id: ULID) {
    guard let i = snips.firstIndex(where: { $0.id == id }) else { return }
    if shown == id {
      let rest = snips.indices.filter { $0 != i }
      chosen = (rest.first { $0 > i } ?? rest.last).map { snips[$0].id }
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

/// A snip's page is editing (its title, its words, the clip's ends) rather than being read.
struct SnipEditingKey: PreferenceKey {
  static let defaultValue = false
  static func reduce(value: inout Bool, nextValue: () -> Bool) { value = value || nextValue() }
}

struct SnipRow: View {
  let snip: Snip

  var body: some View {
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
