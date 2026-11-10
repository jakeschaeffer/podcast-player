import PodcastAPI
import SwiftUI

/// Every snip, newest first, paged with the server's cursor. Tap one to open its page; swipe to delete.
struct SnipsView: View {
  @Environment(AppModel.self) private var model
  @State private var snips: [Snip] = []
  @State private var next: String?
  @State private var error: String?
  @State private var loading = false
  @State private var loadingMore = false
  @State private var loaded = false
  @State private var opened: SnipRoute?

  var body: some View {
    List {
      if let error { Text(error).foregroundStyle(.secondary) }
      ForEach(snips) { snip in
        Button { opened = SnipRoute(id: snip.id) } label: { SnipRow(snip: snip) }
          .buttonStyle(.plain)
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
      } else if loaded && snips.isEmpty && error == nil {
        ContentUnavailableView("No snips yet", systemImage: "scissors",
          description: Text("Tap the scissors in the player to save a moment."))
      }
    }
    .navigationTitle("Snips")
    .task { if !loaded { await load(more: false) } }
    .refreshable { await load(more: false) }
    .navigationDestination(item: $opened) { route in
      SnipPage(snipID: route.id, api: model.api, onChange: replace) {
        snips.removeAll { $0.id == route.id }
      }
    }
    #if DEBUG
      // `-openSnip <id>` opens that snip's page at launch, for scripted simulator checks.
      .task {
        if let id = UserDefaults.standard.string(forKey: "openSnip") { opened = SnipRoute(id: id) }
      }
    #endif
  }

  private func delete(_ snip: Snip) async {
    snips.removeAll { $0.id == snip.id }
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
