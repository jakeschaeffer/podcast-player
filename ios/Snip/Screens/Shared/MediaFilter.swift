import SwiftUI

/// All, podcasts, or videos: the choice above Today's new episodes and the Library's shows, kept between visits.
enum MediaFilter: String, CaseIterable, Identifiable {
  case all, audio, video

  static let key = "mediaFilter"
  var id: String { rawValue }
  var name: String {
    switch self {
    case .all: "All"
    case .audio: "Podcasts"
    case .video: "Videos"
    }
  }

  /// Whether an episode's `mediaKind` ("audio" | "video"), or a show's, is shown.
  func includes(_ kind: String) -> Bool { self == .all || rawValue == kind }

  /// The segmented control, as a list row above what it filters.
  static func picker(_ selection: Binding<MediaFilter>) -> some View {
    Picker("Podcasts or videos", selection: selection) {
      ForEach(allCases) { Text($0.name).tag($0) }
    }
    .pickerStyle(.segmented)
    .listRowSeparator(.hidden)
  }
}
