import PlayerKit
import PodcastAPI
import SwiftUI

/// Up next, in the owner's order (on any device): press and hold an episode to drag it to a new place. When the
/// playing episode ends, the first here starts. Leaving an episode partway for another puts it at the top. Swipe to
/// take one out (it comes back if played again) or to mark it played. Tapping one opens it without playing it. No
/// context menu: press and hold is the drag, and a menu there would turn a drag into a tap on its first item.
struct UpNextView: View {
  @Environment(AppModel.self) private var model
  @Environment(PlayerEngine.self) private var engine
  @State private var loaded = false

  var body: some View {
    List {
      if !model.queue.isEmpty {
        Text(model.queue.count > 1 ? "Plays in this order. Press and hold an episode to move it." : "Plays when this episode ends.")
          .font(.footnote)
          .foregroundStyle(.secondary)
          .listRowSeparator(.hidden)
          .moveDisabled(true)
      }
      ForEach(model.queue) { episode in
        EpisodeRow(episode: episode) { engine.open(episode.id) }
          .swipeActions {
            Button("Remove", systemImage: "minus.circle") { model.removeFromQueue(episode) }
              .tint(.red)
            Button("Played", systemImage: "checkmark.circle") { model.markPlayed(episode) }
              .tint(.green)
          }
      }
      .onMove { model.moveQueue(from: $0, to: $1) }
    }
    .listStyle(.plain)
    .overlay {
      if loaded && model.queue.isEmpty {
        ContentUnavailableView(
          "Nothing up next", systemImage: "list.bullet",
          description: Text("Add episodes from a show or Today, or leave one partway through, and they line up here."))
      } else if !loaded && model.queue.isEmpty {
        ProgressView()
      }
    }
    .task(id: engine.episode?.id) {
      await model.refreshQueue()
      loaded = true
    }
  }
}
