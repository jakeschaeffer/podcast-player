import PlayerKit
import PodcastAPI
import SwiftUI

/// What the player does when the phone is turned sideways while an episode plays: read along in the karaoke view, or
/// keep the player, laid out in two columns like the web app's wide layout. Set from the transcript's Aa menu or
/// Today's account menu. A snip's page always reads along sideways.
/// What the player does turned sideways with an audio episode. A video turned sideways always fills the screen
/// (VideoSideways), so there is no choice to make for it.
enum SidewaysPlayer: String, CaseIterable, Identifiable {
  case karaoke, rotate

  static let key = "player.sideways"
  var id: String { rawValue }
  var name: String {
    switch self {
    case .karaoke: "Read along"
    case .rotate: "Turn the player"
    }
  }

  /// The choices, for a menu.
  static func picker(_ selection: Binding<SidewaysPlayer>) -> some View {
    Picker("Turned sideways", systemImage: "rectangle.landscape.rotate", selection: selection) {
      ForEach(allCases) { Text($0.name).tag($0) }
    }
  }
}

/// Transcripts as loaded from the server, the last few kept so switching panels or turning the phone doesn't fetch the
/// same one again.
@MainActor
enum TranscriptCache {
  private static var recent: [(id: ULID, transcript: Transcript)] = []

  static func cached(_ id: ULID) -> Transcript? { recent.first { $0.id == id }?.transcript }

  /// With `offline`, a transcript saved with a download stands in when the server cannot be reached.
  static func load(_ id: ULID, api: APIClient, offline: DownloadStore? = nil) async throws -> Transcript {
    if let hit = cached(id) { return hit }
    let transcript: Transcript
    do {
      transcript = try await api.transcript(id)
    } catch {
      guard let saved = offline?.cachedTranscript(id) else { throw error }
      transcript = saved
    }
    recent.removeAll { $0.id == id }
    recent.insert((id, transcript), at: 0)
    if recent.count > 3 { recent.removeLast() }
    return transcript
  }
}

/// The karaoke reading view's text, after the audiobook app's: white on black, as large as it fits, in two fixed halves
/// of the screen. One half holds the piece being spoken and the other the next; words light up as they are spoken, and
/// when speech moves on, the half it left fades to the piece after (KaraokePieces). Opacity is the only motion.
struct KaraokeHalves: View {
  let pieces: [KaraokePieces.Piece]
  /// Where playback is; nil before it starts, when the first piece reads in full.
  let positionMs: Int?

  var body: some View {
    let active = positionMs.map { KaraokePieces.index(pieces, at: $0) } ?? 0
    let slots = KaraokePieces.slots(active: active, count: pieces.count)
    GeometryReader { geo in
      VStack(spacing: 0) {
        slot(slots.top, active: active).frame(height: geo.size.height / 2)
        slot(slots.bottom, active: active).frame(height: geo.size.height / 2)
      }
    }
  }

  private func slot(_ index: Int?, active: Int) -> some View {
    ZStack(alignment: .leading) {
      if let index {
        Text(text(pieces[index], active: index == active))
          .font(.system(size: 52, weight: .semibold, design: .rounded))
          .minimumScaleFactor(0.5)
          .lineLimit(3)
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
          .id(index)
          .transition(.opacity)
      }
    }
    .animation(.easeInOut(duration: 0.5), value: index)
  }

  /// The active piece is white up to the word being spoken and grey after it; the waiting piece is dimmer still.
  private func text(_ piece: KaraokePieces.Piece, active: Bool) -> AttributedString {
    var out = AttributedString()
    for (i, word) in piece.words.enumerated() {
      var part = AttributedString(i == piece.words.count - 1 ? word.text : word.text + " ")
      let spoken = positionMs.map { word.startMs <= $0 } ?? true
      part.foregroundColor = active ? (spoken ? .white : .white.opacity(0.65)) : .white.opacity(0.5)
      out += part
    }
    return out
  }
}

/// A thin accent line along the bottom: how far through the clip or episode playback is.
struct KaraokeProgress: View {
  let progress: Double

  var body: some View {
    GeometryReader { geo in
      ZStack(alignment: .leading) {
        Capsule().fill(.white.opacity(0.2))
        Capsule().fill(Color.accentColor).frame(width: geo.size.width * min(max(progress, 0), 1))
      }
      .frame(height: 4)
    }
    .frame(height: 4)
    .accessibilityHidden(true)
  }
}
