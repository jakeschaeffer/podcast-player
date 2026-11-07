import PlayerKit
import PodcastAPI
import SwiftUI

/// The Up Next tab: what plays after the current episode, in the owner's order (on any device), and nothing else.
/// Tap an episode to open it; swipe it to play it now, take it out (it comes back if played again) or mark it played;
/// Edit shows the handles for moving and the minus for removing, which press-and-hold dragging also does. The same
/// list sits in the player as a panel (UpNextList).
struct UpNextView: View {
  @Environment(PlayerEngine.self) private var engine
  @Binding var showPlayer: Bool
  /// Held here so a scripted check can start in edit mode (`-editUpNext 1`, DEBUG).
  @State private var editMode = EditMode.inactive

  var body: some View {
    UpNextList { episode, playing in
      engine.open(episode.id, autoplay: playing)
      showPlayer = true
    }
    .navigationTitle("Up Next")
    .toolbar { EditButton() }
    .environment(\.editMode, $editMode)
    #if DEBUG
      .onAppear { if UserDefaults.standard.bool(forKey: "editUpNext") { editMode = .active } }
    #endif
  }
}

/// Up next as a plain list of episodes. No words of its own beyond the empty state: the rows are the content.
/// No context menu: press and hold is the drag, and a menu there would turn a drag into a tap on its first item.
struct UpNextList: View {
  @Environment(AppModel.self) private var model
  @Environment(PlayerEngine.self) private var engine
  @State private var loaded = false
  /// Opens an episode; `playing` when the row's Play action asked for it to start.
  let open: (_ episode: Episode, _ playing: Bool) -> Void

  var body: some View {
    List {
      ForEach(model.queue) { episode in
        UpNextRow(episode: episode) { open(episode, false) }
          .swipeActions(edge: .leading) {
            Button("Play", systemImage: "play.fill") { open(episode, true) }
              .tint(.accentColor)
          }
          .swipeActions(edge: .trailing) {
            Button("Remove", systemImage: "minus.circle") { model.removeFromQueue(episode) }
              .tint(.red)
            Button("Played", systemImage: "checkmark.circle") { model.markPlayed(episode) }
              .tint(.green)
          }
      }
      .onMove { model.moveQueue(from: $0, to: $1) }
      .onDelete { offsets in
        for episode in offsets.map({ model.queue[$0] }) { model.removeFromQueue(episode) }
      }
    }
    .listStyle(.plain)
    .overlay {
      if loaded && model.queue.isEmpty {
        ContentUnavailableView("Nothing up next", systemImage: "text.line.last.and.arrowtriangle.forward")
      } else if !loaded && model.queue.isEmpty {
        ProgressView()
      }
    }
    .refreshable { await model.refreshQueue() }
    .task(id: engine.episode?.id) {
      await model.refreshQueue()
      loaded = true
    }
  }
}

/// One episode up next: artwork, title, and the show with how long it runs (or how much is left). Beside each other
/// at ordinary text sizes; at accessibility sizes the artwork sits above the words, which then have the row's full
/// width, so a title still reads in two or three lines rather than one word per line.
struct UpNextRow: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dynamicTypeSize) private var typeSize
  @ScaledMetric(relativeTo: .body) private var artwork: CGFloat = 52
  let episode: Episode
  let action: () -> Void

  private var stacked: Bool { typeSize.isAccessibilitySize }

  var body: some View {
    Button(action: action) {
      let layout = stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8)) : AnyLayout(HStackLayout(spacing: 12))
      layout {
        Artwork(url: model.artwork(episodeImage: episode.imageUrl, feedID: episode.feedId), size: min(artwork, 88))
        VStack(alignment: .leading, spacing: 3) {
          Text(episode.title).font(.body.weight(.medium)).lineLimit(stacked ? 3 : 2)
          // The time is kept whole; a long show name is what gives way. At accessibility sizes the two take a line each.
          let line = stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: 0)) : AnyLayout(HStackLayout(spacing: 4))
          line {
            if let show = episode.showTitle, !show.isEmpty { Text(show).lineLimit(1) }
            if let time, !stacked, episode.showTitle?.isEmpty == false { Text("·") }
            if let time { Text(time).layoutPriority(1) }
          }
          .font(.subheadline)
          .foregroundStyle(.secondary)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.vertical, 2)
    }
    .buttonStyle(.plain)
    .accessibilityElement(children: .combine)
  }

  /// How much is left of one heard partway, else how long it runs.
  private var time: String? {
    guard let total = episode.durationMs else { return nil }
    if let resume = episode.resume, !resume.finished, resume.positionMs > 0 { return "\(Format.clock(total - resume.positionMs)) left" }
    return Format.clock(total)
  }
}
