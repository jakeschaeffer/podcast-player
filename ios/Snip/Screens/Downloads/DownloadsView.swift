import PlayerKit
import PodcastAPI
import SwiftUI

struct DownloadsRoute: Hashable {}

/// What is on the phone, newest first, with its size; swipe to take one off. The settings at the foot say how many of
/// Up next's first episodes the phone keeps by itself, and whether downloads may use cellular data.
struct DownloadsView: View {
  @Environment(AppModel.self) private var model
  @Environment(PlayerEngine.self) private var engine
  @AppStorage(AppModel.autoDownloadKey) private var autoDownload = 0
  @Binding var showPlayer: Bool

  var body: some View {
    let downloads = model.downloads
    let items = downloads.items.sorted { $0.createdAt > $1.createdAt }
    List {
      if items.isEmpty && downloads.pending.isEmpty {
        ContentUnavailableView("Nothing downloaded", systemImage: "arrow.down.circle", description: Text("Swipe an episode, or use the arrow in the player, to keep it on the phone."))
          .listRowSeparator(.hidden)
      }
      ForEach(downloads.pending) { d in
        let progress = downloads.progress[d.id] ?? 0
        HStack(spacing: 12) {
          ProgressView(value: progress).progressViewStyle(.circular).controlSize(.regular)
          VStack(alignment: .leading, spacing: 3) {
            Text(d.episodeTitle).font(.body.weight(.medium)).lineLimit(2)
            Text("Downloading \(d.video ? "video" : "audio") · \(progress.formatted(.percent.precision(.fractionLength(0))))")
              .font(.caption).foregroundStyle(.secondary).monospacedDigit()
          }
        }
        .swipeActions {
          Button("Cancel", systemImage: "xmark", role: .destructive) { downloads.cancel(assetID: d.assetID, video: d.video) }
        }
      }
      ForEach(items) { d in
        DownloadRow(download: d) {
          engine.open(d.episodeID)
          showPlayer = true
        }
        .swipeActions {
          Button("Remove", systemImage: "trash", role: .destructive) { downloads.remove(d) }
        }
      }
      Section {
        Picker("Keep Up Next on the phone", selection: $autoDownload) {
          Text("Off").tag(0)
          Text("The next episode").tag(1)
          Text("The next three").tag(3)
        }
        Toggle("Download on cellular", isOn: Binding(get: { downloads.allowsCellular }, set: { downloads.allowsCellular = $0 }))
      } footer: {
        Text("\(Self.size(downloads.totalBytes)) on the phone. A finished episode's download goes a day later.")
      }
    }
    .navigationTitle("Downloads")
    .onChange(of: autoDownload) { _, _ in Task { await model.refreshQueue() } }
  }

  static func size(_ bytes: Int) -> String {
    ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
  }
}

/// A download as a row: artwork, show, title, and what it is (video or audio, its size, whether Up next fetched it, whether
/// it goes soon).
struct DownloadRow: View {
  @Environment(AppModel.self) private var model
  let download: Download
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 12) {
        Artwork(url: artwork, size: 52)
        VStack(alignment: .leading, spacing: 3) {
          Text(download.showTitle ?? "").font(.caption).foregroundStyle(.secondary).lineLimit(1)
          Text(download.episodeTitle).font(.body.weight(.medium)).lineLimit(2)
          Text(detail).font(.caption).foregroundStyle(.secondary)
        }
      }
    }
    .buttonStyle(.plain)
  }

  private var artwork: String? {
    // A download made before the row kept its artwork finds it in the details saved beside it.
    let detail = download.feedID == nil ? model.downloads.cachedDetail(download.episodeID) : nil
    guard let feedID = download.feedID ?? detail?.feedId else { return nil }
    return model.artwork(episodeImage: download.imageUrl ?? detail?.imageUrl, feedID: feedID)
  }

  private var detail: String {
    [download.video ? "Video" : "Audio", DownloadsView.size(download.bytes), download.automatic ? "Up Next" : nil, download.finishedAt != nil ? "finished, goes in a day" : nil]
      .compactMap { $0 }.joined(separator: " · ")
  }
}

/// The arrow in the player: tap to keep the episode on the phone (its video when video is wanted and it has one, else
/// its audio), a ring while it comes, a tick once it is here (tap to take it off again).
struct DownloadButton: View {
  @Environment(AppModel.self) private var model
  @Environment(PlayerEngine.self) private var engine
  let episode: EpisodeDetail

  var body: some View {
    if let asset = episode.asset {
      let video = engine.wantsVideo && asset.videoUrl != nil
      let state = model.downloads.state(assetID: asset.id, video: video) ?? model.downloads.state(assetID: asset.id, video: !video)
      Button {
        switch state {
        case nil: model.downloads.download(episode, video: engine.wantsVideo)
        case .downloading: model.downloads.cancel(assetID: asset.id, video: video)
        case .done: for d in model.downloads.downloads(episodeID: episode.id) { model.downloads.remove(d) }
        }
      } label: {
        switch state {
        case nil:
          Image(systemName: "arrow.down.circle").font(.title2).foregroundStyle(.secondary)
        case .downloading(let progress):
          ProgressView(value: progress).progressViewStyle(.circular).controlSize(.regular)
        case .done:
          Image(systemName: "checkmark.circle.fill").font(.title2).foregroundStyle(Color.accentColor)
        }
      }
      .buttonStyle(.plain)
      .frame(width: 44, height: 44)
      .accessibilityLabel(state == nil ? "Download" : state == .done ? "Remove download" : "Cancel download")
    }
  }
}
