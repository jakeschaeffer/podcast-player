import AVFoundation
import PlayerKit
import PodcastAPI
import SwiftUI

/// Every snip from one episode, in episode order, like web/src/snips/EpisodeSnips.tsx. Choosing one opens its page; the play button plays just that snip's clip (the episode pauses for it and stays where it was); swipe
/// to delete one.
///
/// "Share all" publishes one page with every shared snip of the episode (`/e/{token}`). The page reads the snips when
/// it is opened, so later snips appear on it too.
struct EpisodeSnipsView: View {
  @Environment(AppModel.self) private var model
  @Environment(PlayerEngine.self) private var engine
  @Environment(\.dismiss) private var dismiss
  let episode: EpisodeDetail
  @State private var snips: [Snip]?
  @State private var share: EpisodeShare?
  @State private var error: String?
  @State private var busy = false
  @State private var clip: (id: ULID, player: AVPlayer)?
  @State private var opened: SnipRoute?

  var body: some View {
    NavigationStack {
      List {
        if let error { Text(error).foregroundStyle(.red) }
        if let share { shareSection(share) }
        ForEach(snips ?? []) { snip in
          HStack(spacing: 12) {
            Button {
              stopClip()
              opened = SnipRoute(id: snip.id)
            } label: {
              VStack(alignment: .leading, spacing: 4) {
                Text(snip.revision?.title ?? (snip.isPending ? "Choosing the moment…" : "Snip"))
                  .font(.body.weight(.medium)).lineLimit(2)
                Text(meta(snip)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
              }
              .frame(maxWidth: .infinity, alignment: .leading)
              .contentShape(.rect)
            }
            .buttonStyle(.plain)
            if let rev = snip.revision, let url = rev.clipUrl.flatMap({ SignedURL.onServer($0, base: model.serverURL) }) {
              Button { toggleClip(rev.id, url) } label: {
                // A film frame for a snip cut from the video, a plain play for one cut from the audio.
                Image(systemName: clip?.id == rev.id ? "stop.fill" : snip.mediaKind == "video" ? "play.rectangle.fill" : "play.fill")
                  .frame(width: 36, height: 36)
              }
              .buttonStyle(.bordered)
              .buttonBorderShape(.circle)
              .accessibilityLabel(clip?.id == rev.id ? "Stop clip" : "Play clip")
            }
          }
          .swipeActions {
            Button("Delete", systemImage: "trash", role: .destructive) { Task { await delete(snip) } }
          }
        }
      }
      .overlay {
        if snips == nil && error == nil {
          ProgressView()
        } else if snips?.isEmpty == true {
          ContentUnavailableView("No snips from this episode yet", systemImage: "scissors")
        }
      }
      .navigationDestination(item: $opened) { route in
        SnipPage(snipID: route.id, api: model.api, onChange: replace) {
          snips?.removeAll { $0.id == route.id }
        }
      }
      .navigationTitle(snips.map { "Snips · \($0.count)" } ?? "Snips")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") { dismiss() }
        }
        ToolbarItem(placement: .primaryAction) {
          if let share, share.state == "active", let url = URL(string: share.shareUrl ?? "") {
            ShareLink(item: url, subject: Text("Snips from \(episode.title)")) {
              Label("Share all", systemImage: "square.and.arrow.up")
            }
          } else {
            Button {
              Task { await publish() }
            } label: {
              Label("Share all", systemImage: "square.and.arrow.up")
            }
            .disabled(busy || (snips ?? []).isEmpty)
          }
        }
      }
    }
    .task { await load() }
    .onDisappear { stopClip() }
    .onReceive(NotificationCenter.default.publisher(for: AVPlayerItem.didPlayToEndTimeNotification)) { note in
      if let item = note.object as? AVPlayerItem, item === clip?.player.currentItem { clip = nil }
    }
  }

  @ViewBuilder private func shareSection(_ share: EpisodeShare) -> some View {
    if share.state == "active", let url = URL(string: share.shareUrl ?? "") {
      Section {
        Link(destination: url) { Label("Open the shared page", systemImage: "globe") }
        Button("Stop sharing", role: .destructive) { Task { await revoke() } }
          .disabled(busy)
      } footer: {
        Text("Anyone with the link sees every shared snip from this episode, including ones made later.")
      }
    } else if share.state == "revoked" {
      Section { Label("Page withdrawn", systemImage: "eye.slash").foregroundStyle(.secondary) }
    }
  }

  private func meta(_ snip: Snip) -> String {
    // While the moment is still being chosen the revision's span is a placeholder; say where the tap was.
    let chosen = snip.revision.flatMap { $0.status == .waiting || $0.status == .selecting ? nil : $0 }
    let span = chosen.map {
      "\(Format.clock($0.startMs)) – \(Format.clock($0.endMs)) (\(Format.clock($0.endMs - $0.startMs)))"
    } ?? "at \(Format.clock(snip.anchorMs))"
    let when = Date(timeIntervalSince1970: Double(snip.createdAt) / 1000).formatted(.relative(presentation: .named))
    return [span, when, snip.shareState == "revoked" ? "link revoked" : nil].compactMap { $0 }.joined(separator: " · ")
  }

  private func load() async {
    do {
      async let page = model.api.snips(episodeID: episode.id, limit: 200)
      async let shared = model.api.episodeShare(episode.id)
      snips = try await page.items.sorted { ($0.revision?.startMs ?? $0.anchorMs) < ($1.revision?.startMs ?? $1.anchorMs) }
      share = try await shared
      error = nil
    } catch {
      self.error = error.localizedDescription
      snips = snips ?? []
    }
  }

  private func replace(_ snip: Snip) {
    if let i = snips?.firstIndex(where: { $0.id == snip.id }) { snips?[i] = snip }
  }

  /// Swipe to delete: the snip leaves the list at once, and its public link stops serving.
  private func delete(_ snip: Snip) async {
    if clip?.id == snip.revision?.id { stopClip() }
    snips?.removeAll { $0.id == snip.id }
    do {
      try await model.api.deleteSnip(snip.id)
      error = nil
    } catch {
      self.error = error.localizedDescription
      await load()
    }
  }

  private func publish() async {
    busy = true
    defer { busy = false }
    do {
      share = try await model.api.shareEpisode(episode.id)
      error = nil
    } catch {
      self.error = error.localizedDescription
    }
  }

  private func revoke() async {
    busy = true
    defer { busy = false }
    do {
      share = try await model.api.revokeEpisodeShare(episode.id)
      error = nil
    } catch {
      self.error = error.localizedDescription
    }
  }

  /// The clip plays on its own player, which never reports playback; the episode pauses and stays where it was.
  private func toggleClip(_ id: ULID, _ url: URL) {
    let same = clip?.id == id
    stopClip()
    if same { return }
    engine.pause()
    let player = AVPlayer(url: url)
    clip = (id, player)
    player.play()
  }

  private func stopClip() {
    clip?.player.pause()
    clip = nil
  }
}
