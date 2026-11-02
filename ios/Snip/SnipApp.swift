import SwiftUI

@main
struct SnipApp: App {
  @State private var model = AppModel()
  @Environment(\.scenePhase) private var scenePhase
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

  var body: some Scene {
    WindowGroup {
      Group {
        if model.signedIn {
          RootView()
        } else {
          LoginView()
        }
      }
      .environment(model)
      .environment(model.engine)
      .onChange(of: scenePhase) { _, phase in
        if phase == .active || phase == .background { model.flushOutboxes() }
        if phase == .active { model.downloads.dropFinished() }
      }
    }
  }
}

struct RootView: View {
  @Environment(AppModel.self) private var model
  @State private var showPlayer = false
  @State private var tab = 0
  @State private var todayPath = NavigationPath()

  var body: some View {
    TabView(selection: $tab) {
      Tab("Today", systemImage: "sun.max", value: 0) {
        NavigationStack(path: $todayPath) { TodayView(showPlayer: $showPlayer, path: $todayPath) }
      }
      Tab("Library", systemImage: "square.stack", value: 1) {
        NavigationStack { LibraryView(showPlayer: $showPlayer) }
      }
      Tab("Snips", systemImage: "scissors", value: 2) {
        NavigationStack { SnipsView() }
      }
    }
    .modifier(MiniPlayerAccessory(showPlayer: $showPlayer, enabled: !model.readingSideways))
    .sheet(isPresented: $showPlayer) {
      PlayerView()
    }
    #if DEBUG
      // `-muteAudio 1` keeps every simulator check silent: the player plays, but nothing reaches the Mac's speakers.
      // `-openEpisode <id>` opens the player on that episode at launch, for scripted simulator checks.
      // `-searchShows <text>` and `-openFeed <id>` open the Library on show search or on a show (LibraryView).
      // `-openSnip <id>` opens the Snips tab on that snip's page (SnipsView).
      .task {
        let defaults = UserDefaults.standard
        if defaults.bool(forKey: "muteAudio") { model.engine.player.isMuted = true }
        if defaults.string(forKey: "searchShows") != nil || defaults.string(forKey: "openFeed") != nil { tab = 1 }
        if defaults.string(forKey: "openSnip") != nil { tab = 2 }
        if let id = defaults.string(forKey: "openEpisode") {
          model.engine.open(id, autoplay: true)
          showPlayer = true
        }
      }
    #endif
  }
}

/// The mini player under the tabs. It steps aside while a snip is read sideways (iOS 26.1 can turn the accessory off).
private struct MiniPlayerAccessory: ViewModifier {
  @Binding var showPlayer: Bool
  let enabled: Bool

  func body(content: Content) -> some View {
    if #available(iOS 26.1, *) {
      content.tabViewBottomAccessory(isEnabled: enabled) { MiniPlayer(showPlayer: $showPlayer) }
    } else {
      content.tabViewBottomAccessory { MiniPlayer(showPlayer: $showPlayer) }
    }
  }
}
