import PlayerKit
import PodcastAPI
import SwiftUI

struct UpNextRoute: Hashable {}

/// Up Next, pushed from Today's queue button: what plays after the current episode, in the owner's order (on any
/// device), and nothing else. Tap an episode to open it; swipe it to play it now, take it out (it comes back if played
/// again) or mark it played; Edit shows the handles for moving and the minus for removing, which press-and-hold
/// dragging also does. The same list sits in the player as a panel (UpNextList), which is where it is reached while
/// listening; it is not a tab, since the queue is part of playing rather than a place of its own.
struct UpNextView: View {
  @Environment(AppModel.self) private var model
  @Environment(PlayerEngine.self) private var engine
  @Environment(\.horizontalSizeClass) private var horizontalSizeClass
  @Environment(\.verticalSizeClass) private var verticalSizeClass
  @Binding var showPlayer: Bool
  /// Held here so a scripted check can start in edit mode (`-editUpNext 1`, DEBUG).
  @State private var editMode = EditMode.inactive
  @State private var size = CGSize.zero

  /// The iPhone Duo open and held wide: the queue on the left page, what plays now (or next) large on the right.
  private var spread: Bool { UnfoldedDisplay.isSpread(horizontal: horizontalSizeClass, vertical: verticalSizeClass, size: size) }

  var body: some View {
    HingeSplit(split: spread, gapFill: Color(.systemBackground)) {
      UpNextList { episode, playing in open(episode.id, playing: playing) }
    } trailing: {
      feature
    }
    .onGeometryChange(for: CGSize.self) { $0.size } action: { size = $0 }
    .navigationTitle("Up Next")
    .toolbar { EditButton() }
    .environment(\.editMode, $editMode)
    #if DEBUG
      .onAppear { if UserDefaults.standard.bool(forKey: "editUpNext") { editMode = .active } }
    #endif
  }
}

extension UpNextView {
  private func open(_ id: ULID, playing: Bool) {
    engine.open(id, autoplay: playing)
    showPlayer = true
  }

  /// Held wide, the right page: the episode playing, or else the first up, with its whole cover (never cropped),
  /// its title and show in large type, and Play.
  @ViewBuilder fileprivate var feature: some View {
    let playing = engine.episode
    let next = model.queue.first
    if let id = playing?.id ?? next?.id {
      let title = playing?.title ?? next?.title ?? ""
      let show = playing?.showTitle ?? next?.showTitle
      let image = playing.map { model.artwork(episodeImage: $0.imageUrl, feedID: $0.feedId) }
        ?? next.map { model.artwork(episodeImage: $0.imageUrl, feedID: $0.feedId) }
      VStack(alignment: .leading, spacing: 16) {
        Text(playing != nil ? "Playing" : "Next").font(.title3.weight(.bold)).foregroundStyle(.secondary)
        Button { open(id, playing: false) } label: {
          VStack(alignment: .leading, spacing: 12) {
            // Whole, square or wide, never cropped (the owner's rule for covers).
            FittedArtwork(url: image ?? nil, width: 380, height: 240)
              .frame(maxWidth: .infinity, alignment: .leading)
            Text(title).font(.title2.weight(.bold)).lineLimit(4).multilineTextAlignment(.leading)
            if let show, !show.isEmpty {
              Text(show).font(.title3).foregroundStyle(.secondary).lineLimit(2)
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .contentShape(.rect)
        }
        .buttonStyle(.plain)
        if playing == nil {
          Button { open(id, playing: true) } label: {
            Label("Play", systemImage: "play.fill").font(.title3.weight(.bold)).frame(maxWidth: .infinity, minHeight: 44)
          }
          .buttonStyle(.borderedProminent)
          .buttonBorderShape(.capsule)
        }
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 24)
      .padding(.top, 8)
    } else {
      Color.clear
    }
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
