import PodcastAPI
import SnipActivity
import SwiftUI
import SyncKit

@main
struct SnipApp: App {
  @State private var model = AppModel.shared
  @Environment(\.scenePhase) private var scenePhase
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

  /// The model is made here, when the process starts, and not when the first screen is drawn. iOS also launches the
  /// app out of sight, with no screen at all, for a button on the Live Activity pressed after it ended the app: `@State`
  /// builds an observable object only once a view reads it, so that launch had no model, nothing had installed the
  /// buttons' handler, and Play, Snip and Skip ad on the card did nothing.
  init() {
    _ = AppModel.shared
  }

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
          Task { await model.refreshLibrary() }
        }
      }
    }
  }

  private var app: some View {
    Group {
      if model.signedIn {
        RootView()
      } else {
        LoginView()
      }
    }
    // Outside RootView, so the sheets it presents read larger on the open iPhone Duo too.
    .unfoldedTypeScale()
  }
}

struct RootView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.horizontalSizeClass) private var horizontalSizeClass
  @Environment(\.verticalSizeClass) private var verticalSizeClass
  @State private var showPlayer = false
  @State private var tab = 0
  @State private var todayPath = NavigationPath()
  /// When the device was last folded or opened, and whether the player is being shown again after it (`ended`).
  @State private var foldedAt = Date.distantPast
  @State private var reopening = false

  /// The iPhone Duo open: a sheet there is a floating card with the screen showing round it, so the player takes the
  /// whole display instead (and is closed with its own button). Folding it moves the player to a sheet and back.
  private var unfolded: Bool { UnfoldedDisplay.isUnfolded(horizontal: horizontalSizeClass, vertical: verticalSizeClass) }
  /// The player takes the whole display: open, and on its side, where the read-along and a video fill the screen
  /// edge to edge rather than sit in a sheet's card with its border showing. Turning or folding hands it between the
  /// sheet and the cover.
  private var coversScreen: Bool { unfolded || verticalSizeClass == .compact }
  /// An episode is in the player, or on its way into it.
  private var hasEpisode: Bool { model.engine.episode != nil || model.engine.status == .loading }

  /// The player's sheet or cover was dismissed on its own kind of display: closed by the owner, unless the device was
  /// folded or opened a moment ago. Then it is the hand-over between the two going wrong (the new one can't be shown
  /// while the old one is still leaving, and SwiftUI reports it dismissed), so the player is shown again once that is
  /// done, with the snip page it had (AppModel.playerSnip).
  private func ended() {
    guard Date.now.timeIntervalSince(foldedAt) < 2 else {
      showPlayer = false
      return
    }
    reopening = true
    showPlayer = false
    Task {
      try? await Task.sleep(for: .milliseconds(800))
      showPlayer = true
      reopening = false
    }
  }

  var body: some View {
    TabView(selection: $tab) {
      Tab("Today", systemImage: "sun.max", value: 0) {
        NavigationStack(path: $todayPath) { TodayView(showPlayer: $showPlayer, path: $todayPath) }
      }
      Tab("Library", systemImage: "square.stack", value: 1) {
        NavigationStack { LibraryView(showPlayer: $showPlayer) }
      }
      // With no server there are no snips yet (docs/store-app-plan.md, step 3).
      if model.hasServer {
        Tab("Snips", systemImage: "scissors", value: 2) {
          NavigationStack { SnipsView() }
        }
      }
    }
    // The floating glass tab bar let the last row's words show through it and run into its labels (the Duo open and
    // turned tall most of all): a hard edge ends every list cleanly above the bar.
    .scrollEdgeEffectStyle(.hard, for: .bottom)
    // Only with something to show: an empty "Nothing playing" bar was one more layer over every list, and a tap on it
    // opened an empty player.
    .modifier(MiniPlayerAccessory(showPlayer: $showPlayer, enabled: !model.readingSideways && hasEpisode))
    // Each presentation is shown only on its own kind of display; one dismissed because the device was folded or
    // opened leaves `showPlayer` alone, so the other takes over.
    .sheet(isPresented: Binding(get: { showPlayer && !coversScreen }, set: { if !$0, !coversScreen { ended() } })) {
      player(fullScreen: false)
    }
    .fullScreenCover(isPresented: Binding(get: { showPlayer && coversScreen }, set: { if !$0, coversScreen { ended() } })) {
      player(fullScreen: true).unfoldedTypeScale()
    }
    // The same, opened from the Snips tab with the player down.
    .modifier(WaitingSnipPresenter(active: !showPlayer, coversScreen: coversScreen))
    // The player closed (not just moved by a fold): the snip page pushed in it goes with it, as it did when the page
    // lived in the player's own state.
    .onChange(of: showPlayer) { _, shown in if !shown, !reopening { model.playerSnip = nil } }
    .onChange(of: coversScreen) { foldedAt = .now }
    // The Live Activity's title was tapped: the player takes it from there (PlayerView.openRename).
    .onChange(of: model.renameRequest, initial: true) { _, id in if id != nil { showPlayer = true } }
    #if DEBUG
      // `-muteAudio 1` keeps every simulator check silent: the player plays, but nothing reaches the Mac's speakers
      // (applied where the player is made, in AppModel, so a launch with no screen is silent too).
      // `-openEpisode <id>` opens the player on that episode at launch, for scripted simulator checks.
      // `-searchShows <text>` and `-openFeed <id>` open the Library on show search or on a show (LibraryView).
      // `-openSnip <id>` opens the Snips tab on that snip's page, and `-openSnipsEpisode <id>` on that episode's snips,
      // with `-chooseSnipsShow 1` the list of shows over it, and `-searchSnips <text>` searches them (SnipsView). `-openUpNext 1` opens Up Next from Today's
      // queue button (`-editUpNext 1` in edit mode). After `-openEpisode`, `-seekTo <ms>` starts there (say, in an ad break), and
      // `-autoSnipAfter <s>` snips that many seconds later, as a tap on Snip would, to follow a snip on the Live Activity;
      // `-renameAfter <s>` then opens its rename link, as a tap on the activity's title does. `-openURL <link>` opens a
      // link at launch. `-openTab library|snips` starts on that tab, and `-openWaitingSnip 1` opens the newest tap
      // waiting on the phone (WaitingSnipSheet), for screenshots of every page (ios/scripts/duo.sh on the iPhone Duo).
      // On a snip's page (SnipPage.debugLaunch): `-snipMode adjust` opens the editor, `-editSnipField title|summary|note`
      // opens that field for typing (several, comma-separated, in turn), `-typeText <text>` fills it (`\n` for a new line,
      // `|` between fields) and `-saveFieldAfter <s>` presses its Save. `-openSnipFromBarAfter <s>` presses the snip bar's
      // round arrow that long after the server has the tap (SnipPill), to write on a snip that is still being made.
      // With no server (`-usePhone 1`, AppModel.init): `-followFeed <feed address>` follows that show first, and
      // `-playFirst 1` opens the player on the newest episode, since the phone's ids are its own.
      .task {
        let defaults = UserDefaults.standard
        if let feed = defaults.string(forKey: "followFeed") {
          _ = try? await model.api.createFeed(CreateFeed(url: feed, followed: true))
        }
        if defaults.bool(forKey: "playFirst"), let first = try? await model.api.episodes(limit: 1).items.first {
          model.engine.open(first.id, autoplay: true)
          showPlayer = true
        }
        switch defaults.string(forKey: "openTab") {
        case "library": tab = 1
        case "snips": tab = 2
        default: break
        }
        if defaults.string(forKey: "searchShows") != nil || defaults.string(forKey: "openFeed") != nil { tab = 1 }
        if defaults.string(forKey: "openSnip") != nil { tab = 2 }
        if defaults.bool(forKey: "openWaitingSnip") {
          // The outbox is read in the background at launch (AppModel.init).
          for _ in 0..<50 where model.waitingSnips.isEmpty { try? await Task.sleep(for: .milliseconds(100)) }
          model.editingWaiting = model.waitingSnips.last
        }
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

  private func player(fullScreen: Bool) -> some View {
    PlayerView(fullScreen: fullScreen)
      // A waiting snip opened from the snip bar; over the player, which is itself presented.
      .modifier(WaitingSnipPresenter(active: true, coversScreen: fullScreen))
  }
}

/// A snip waiting on the phone, opened to write on: a sheet on the phone, the whole screen on the open Duo, where a
/// sheet would float as a small card over everything. Folding or opening hands it from one to the other.
private struct WaitingSnipPresenter: ViewModifier {
  @Environment(AppModel.self) private var model
  let active: Bool
  let coversScreen: Bool

  private func binding(full: Bool) -> Binding<SnipOutbox.Pending?> {
    Binding(
      get: { active && coversScreen == full ? model.editingWaiting : nil },
      // Only a dismissal of the presentation that is showing ends the edit; one taken down by a fold leaves it for
      // the other.
      set: { new in if new != nil || coversScreen == full { model.editingWaiting = new } }
    )
  }

  func body(content: Content) -> some View {
    content
      .sheet(item: binding(full: false)) { WaitingSnipSheet(pending: $0).environment(model) }
      .fullScreenCover(item: binding(full: true)) { WaitingSnipSheet(pending: $0).environment(model).unfoldedTypeScale() }
  }
}

/// The mini player under the tabs, while an episode is loaded. It steps aside while a snip is read sideways (iOS 26.1
/// can turn the accessory off; 26.0 always shows it).
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
