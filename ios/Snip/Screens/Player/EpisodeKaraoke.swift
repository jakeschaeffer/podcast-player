import PlayerKit
import PodcastAPI
import SwiftUI

/// The episode turned sideways when the setting says to read along: the karaoke view over the whole transcript,
/// following playback (KaraokeHalves), with the sideways controls (SidewaysControls) over it.
struct EpisodeKaraoke<Pill: View>: View {
  @Environment(AppModel.self) private var model
  @Environment(PlayerEngine.self) private var engine
  let episode: EpisodeDetail
  @ViewBuilder let pill: () -> Pill

  @State private var pieces: (id: ULID, pieces: [KaraokePieces.Piece])?
  @State private var failed = false

  var body: some View {
    ZStack {
      Color.black.ignoresSafeArea()
      if let pieces, pieces.id == episode.transcriptId {
        KaraokeHalves(pieces: pieces.pieces, positionMs: engine.positionMs)
          .padding(.horizontal, 24)
          .padding(.top, 12)
          // The snip bar takes the foot of the screen while it is up; the words make room rather than hide under it.
          .padding(.bottom, model.snipCard == nil ? 12 : 92)
          .animation(.easeInOut(duration: 0.3), value: model.snipCard == nil)
      } else if failed {
        Text("The transcript could not be loaded").font(.title2).foregroundStyle(.white.opacity(0.7))
      } else {
        ProgressView().tint(.white)
      }
    }
    .overlay(alignment: .bottom) {
      KaraokeProgress(progress: Double(engine.positionMs) / Double(max(engine.durationMs, 1))).padding(.horizontal, 24)
    }
    .sidewaysControls(pill: pill)
    .accessibilityLabel("Reading along. Double-tap for the controls.")
    .task(id: episode.transcriptId) { await load() }
  }

  private func load() async {
    failed = false
    guard let id = episode.transcriptId else { return }
    do {
      let transcript = try await TranscriptCache.load(id, api: model.api, offline: model.downloads)
      pieces = (id, KaraokePieces.split(segments: transcript.segments))
    } catch is CancellationError {
    } catch {
      failed = true
    }
  }
}
