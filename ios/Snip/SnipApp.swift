import SnipActivity
import SwiftUI

@main
struct SnipApp: App {
  @State private var model = AppModel()
  @Environment(\.scenePhase) private var scenePhase
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

  var body: some Scene {
    WindowGroup {
      Group {
        #if DEBUG
          // `-activityGallery <page>` shows the Live Activity's states instead of the app (ActivityGallery).
          if let page = UserDefaults.standard.string(forKey: "activityGallery") {
            ActivityGallery(page: page)
          } else {
            app
          }
        #else
          app
        #endif
      }
      .onOpenURL { model.open($0) }
      .environment(model)
      .environment(model.engine)
      .onChange(of: scenePhase) { _, phase in
        if phase == .active || phase == .background { model.flushOutboxes() }
        if phase == .active {
          model.downloads.dropFinished()
          model.refreshLiveActivity()
        }
      }
    }
  }

  @ViewBuilder private var app: some View {
    if model.signedIn {
      RootView()
    } else {
      LoginView()
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
    // The Live Activity's title was tapped: the player takes it from there (PlayerView.openRename).
    .onChange(of: model.renameRequest, initial: true) { _, id in if id != nil { showPlayer = true } }
    #if DEBUG
      // `-muteAudio 1` keeps every simulator check silent: the player plays, but nothing reaches the Mac's speakers.
      // `-openEpisode <id>` opens the player on that episode at launch, for scripted simulator checks.
      // `-searchShows <text>` and `-openFeed <id>` open the Library on show search or on a show (LibraryView).
      // `-openSnip <id>` opens the Snips tab on that snip's page (SnipsView). `-openUpNext 1` opens Up Next from Today's
      // queue button (`-editUpNext 1` in edit mode). After `-openEpisode`, `-seekTo <ms>` starts there (say, in an ad break), and
      // `-autoSnipAfter <s>` snips that many seconds later, as a tap on Snip would, to follow a snip on the Live Activity;
      // `-renameAfter <s>` then opens its rename link, as a tap on the activity's title does. `-openURL <link>` opens a
      // link at launch.
      .task {
        let defaults = UserDefaults.standard
        if defaults.bool(forKey: "muteAudio") { model.engine.player.isMuted = true }
        if defaults.string(forKey: "searchShows") != nil || defaults.string(forKey: "openFeed") != nil { tab = 1 }
        if defaults.string(forKey: "openSnip") != nil { tab = 2 }
        if defaults.bool(forKey: "openUpNext") { todayPath.append(UpNextRoute()) }
        if let id = defaults.string(forKey: "openEpisode") {
          model.engine.open(id, autoplay: true)
          showPlayer = true
          if defaults.object(forKey: "seekTo") != nil {
            for _ in 0..<100 where model.engine.status != .ready { try? await Task.sleep(for: .milliseconds(100)) }
            model.engine.seek(to: defaults.integer(forKey: "seekTo"))
          }
          let snipAfter = defaults.double(forKey: "autoSnipAfter")
          if snipAfter > 0 {
            try? await Task.sleep(for: .seconds(snipAfter))
            await model.snip()
            let renameAfter = defaults.double(forKey: "renameAfter")
            if renameAfter > 0 {
              try? await Task.sleep(for: .seconds(renameAfter))
              if let id = model.snipCard?.snip?.id, let link = SnipLink.rename(id) { model.open(link) }
            }
          }
        }
        if let link = defaults.string(forKey: "openURL").flatMap(URL.init(string:)) { model.open(link) }
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
