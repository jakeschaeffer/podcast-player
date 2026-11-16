import PodcastAPI
import SwiftUI
import SyncKit
import UIKit

/// Which episode a page of snips is for: enough to draw its head before its snips arrive.
struct SnipsEpisode: Hashable, Identifiable {
  let id: ULID
  let title: String
  let showTitle: String?
  let imageUrl: String?

  init(id: ULID, title: String, showTitle: String?, imageUrl: String?) {
    self.id = id
    self.title = title
    self.showTitle = showTitle
    self.imageUrl = imageUrl
  }

  init(_ row: SnipEpisode) {
    self.init(id: row.episodeId, title: row.episodeTitle, showTitle: row.showTitle, imageUrl: row.imageUrl)
  }

  init(_ episode: EpisodeDetail) {
    self.init(id: episode.id, title: episode.title, showTitle: episode.showTitle, imageUrl: episode.imageUrl)
  }
}

/// Every snip from one episode, in the episode's order: its cover, show and title, one large button to share them all
/// on one public page (`/e/{token}`, which reads the snips when it is opened, so later ones appear on it too), then
/// the taps made with no connection, then the snips. A tap on a snip opens its page; swipe to delete one. The same
/// page is the Snips tab's second level and the player's snips button.
struct EpisodeSnipsPage: View {
  @Environment(AppModel.self) private var model
  /// Beside the Snips list, the list opens a snip across both pages itself; elsewhere this page pushes it.
  @Environment(\.openAcrossPages) private var openAcrossPages
  let episode: SnipsEpisode
  /// A snip changed or went: the list of episodes recounts.
  var onChange: () -> Void = {}
  @State private var snips: [Snip]?
  @State private var share: EpisodeShare?
  @State private var error: String?
  @State private var sharing = false
  @State private var shareSheet: SharedPage?
  @State private var opened: SnipRoute?
  @ScaledMetric(relativeTo: .title) private var coverSize: CGFloat = 88
  private static let rowInsets = EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20)

  /// The taps on this episode still on the phone, the newest first.
  private var waiting: [SnipOutbox.Pending] { model.waitingSnips.filter { $0.episodeID == episode.id }.reversed() }
  /// What the public page shows: every snip whose own link hasn't been withdrawn.
  private var shareable: Int { (snips ?? []).filter { $0.shareState != "revoked" }.count }

  var body: some View {
    List {
      head
        .listRowSeparator(.hidden)
        .listRowInsets(EdgeInsets(top: 8, leading: Self.rowInsets.leading, bottom: 12, trailing: Self.rowInsets.trailing))
      if let error {
        Text(error).font(.body).foregroundStyle(.red).listRowSeparator(.hidden)
      }
      ForEach(waiting) { pending in
        Button { model.editingWaiting = pending } label: { waitingRow(pending) }
          .buttonStyle(.plain)
          .listRowInsets(Self.rowInsets)
          .swipeActions {
            Button("Delete", systemImage: "trash", role: .destructive) { Task { await model.deleteWaiting(pending.id) } }
          }
      }
      ForEach(snips ?? []) { snip in
        Button { open(snip) } label: { row(snip) }
          .buttonStyle(.plain)
          // The head's own inset: beside the fold the list's default one is gone, and the rows would start further left.
          .listRowInsets(Self.rowInsets)
          .swipeActions {
            Button("Delete", systemImage: "trash", role: .destructive) { Task { await delete(snip) } }
          }
      }
    }
    .listStyle(.plain)
    .overlay {
      if snips == nil && error == nil && waiting.isEmpty {
        ProgressView()
      } else if snips?.isEmpty == true && waiting.isEmpty {
        ContentUnavailableView("No snips from this episode", systemImage: "scissors")
      }
    }
    // Named for the back button and VoiceOver; the head already says the show, so the bar shows no title.
    .navigationTitle(episode.showTitle ?? "Snips")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .principal) { Color.clear.frame(width: 1, height: 1).accessibilityHidden(true) }
      if share?.state == "active" {
        ToolbarItem(placement: .topBarTrailing) {
          Menu {
            if let url = share?.shareUrl.flatMap(URL.init(string:)) {
              Link(destination: url) { Label("Open the shared page", systemImage: "globe") }
            }
            Button("Stop sharing", systemImage: "eye.slash", role: .destructive) { Task { await revoke() } }
          } label: {
            Image(systemName: "ellipsis")
          }
          .accessibilityLabel("More")
        }
      }
    }
    .navigationDestination(item: $opened) { route in
      SnipPage(model: model.snipPage(route.id), onChange: replace) {
        snips?.removeAll { $0.id == route.id }
        onChange()
      }
    }
    .sheet(item: $shareSheet) { page in
      ActivitySheet(items: [page.url]) { shareSheet = nil }.presentationDetents([.medium, .large]).ignoresSafeArea()
    }
    .task { await load() }
    .refreshable { await load() }
    // A waiting tap was sent: it is one of the snips now.
    .onChange(of: waiting.count) { old, new in
      if new < old { Task { await load() } }
    }
  }

  // MARK: Head

  private var head: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(spacing: 16) {
        Artwork(url: episode.imageUrl, size: coverSize)
        if let show = episode.showTitle {
          Text(show).font(.title3.weight(.semibold)).foregroundStyle(.secondary).lineLimit(2)
        }
      }
      Text(episode.title).font(.title.weight(.heavy)).lineLimit(3)
      shareButton
    }
  }

  private var shareButton: some View {
    Button { Task { await shareAll() } } label: {
      HStack(spacing: 10) {
        if sharing { ProgressView().tint(.black) } else { Image(systemName: "square.and.arrow.up") }
        Text(shareable == 1 ? "Share the snip" : shareable > 0 ? "Share all \(shareable) snips" : "Share all")
      }
      .font(.title3.weight(.bold))
      .foregroundStyle(.black)
      .frame(maxWidth: .infinity, minHeight: 60)
      .background(Color.accentColor, in: .capsule)
      .contentShape(.capsule)
    }
    .buttonStyle(.plain)
    .disabled(sharing || shareable == 0)
    .opacity(shareable == 0 && snips != nil ? 0.4 : 1)
    .padding(.top, 6)
  }

  // MARK: Rows

  private func row(_ snip: Snip) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(title(snip)).font(.title.weight(.bold)).lineLimit(4).multilineTextAlignment(.leading)
      Text(meta(snip)).font(.body).monospacedDigit().foregroundStyle(.secondary).lineLimit(1)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.vertical, 10)
    .contentShape(.rect)
  }

  private func waitingRow(_ pending: SnipOutbox.Pending) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(pending.body.owner?.title ?? "Snipped at \(Format.clock(pending.body.anchorMs))")
        .font(.title.weight(.bold)).lineLimit(4).multilineTextAlignment(.leading)
      Label("Not sent yet", systemImage: "clock")
        .font(.body.weight(.semibold)).foregroundStyle(Color.accentColor)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.vertical, 10)
    .contentShape(.rect)
  }

  private func open(_ snip: Snip) {
    if let openAcrossPages { openAcrossPages(SnipRoute(id: snip.id)) } else { opened = SnipRoute(id: snip.id) }
  }

  private func title(_ snip: Snip) -> String {
    snip.revision?.title ?? (snip.isPending ? "Choosing the moment…" : "Snip")
  }

  /// Where in the episode it starts, and only what else is unusual about it.
  private func meta(_ snip: Snip) -> String {
    // While the moment is still being chosen the revision's span is a placeholder: say where the tap was.
    let chosen = snip.revision.flatMap { $0.status == .waiting || $0.status == .selecting ? nil : $0 }
    let start = Format.clock(chosen?.startMs ?? snip.anchorMs)
    let status: String? =
      switch snip.revision?.status {
      case .failed: "failed"
      case .waiting: "waiting for transcript"
      default: nil
      }
    return [start, status, snip.shareState == "revoked" ? "link withdrawn" : nil].compactMap { $0 }.joined(separator: " · ")
  }

  // MARK: Loading and sharing

  private func load() async {
    if snips == nil, let saved = model.api.savedEpisodeSnips(episode.id) { snips = ordered(saved.items) }
    do {
      async let page = model.api.snips(episodeID: episode.id, limit: 200)
      async let shared = model.api.episodeShare(episode.id)
      snips = ordered(try await page.items)
      share = try? await shared
      error = nil
    } catch {
      self.error = error.localizedDescription
      snips = snips ?? []
    }
  }

  /// The server returns them in the episode's order already; kept so here too after a replace.
  private func ordered(_ items: [Snip]) -> [Snip] {
    items.sorted { ($0.revision?.startMs ?? $0.anchorMs) < ($1.revision?.startMs ?? $1.anchorMs) }
  }

  private func replace(_ snip: Snip) {
    if let i = snips?.firstIndex(where: { $0.id == snip.id }) { snips?[i] = snip }
  }

  /// Swipe to delete: the snip leaves the page at once, and its public link stops serving.
  private func delete(_ snip: Snip) async {
    snips?.removeAll { $0.id == snip.id }
    do {
      try await model.api.deleteSnip(snip.id)
      error = nil
    } catch {
      self.error = error.localizedDescription
      await load()
    }
    onChange()
  }

  /// Publishes the page (or brings a withdrawn one back at the same link), then offers it to send.
  private func shareAll() async {
    sharing = true
    defer { sharing = false }
    do {
      let page = try await model.api.shareEpisode(episode.id)
      share = page
      error = nil
      if let url = page.shareUrl.flatMap(URL.init(string:)) { shareSheet = SharedPage(url: url) }
    } catch {
      self.error = error.localizedDescription
    }
  }

  private func revoke() async {
    do {
      share = try await model.api.revokeEpisodeShare(episode.id)
      error = nil
    } catch {
      self.error = error.localizedDescription
    }
  }
}

private struct SharedPage: Identifiable {
  let url: URL
  var id: URL { url }
}

/// The system's share sheet for what is already in hand (a link the page has just made).
/// It closes itself once something is done with the link (Copy, Messages), so the sheet holding it goes too.
private struct ActivitySheet: UIViewControllerRepresentable {
  let items: [Any]
  let done: () -> Void
  func makeUIViewController(context: Context) -> UIActivityViewController {
    let controller = UIActivityViewController(activityItems: items, applicationActivities: nil)
    controller.completionWithItemsHandler = { _, _, _, _ in done() }
    return controller
  }
  func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
