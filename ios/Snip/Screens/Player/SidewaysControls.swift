import PlayerKit
import SwiftUI

/// The read-along screen's controls: nothing on screen but the words until a tap, which brings up back 15, play or
/// pause, forward 30 and Snip for a few seconds; Skip ad shows by itself during a suspected ad, and the snip bar at the
/// foot after a snip. (A video turned sideways keeps the player's own controls instead: VideoSideways.)
struct SidewaysControls<Pill: View>: ViewModifier {
  @Environment(AppModel.self) private var model
  @Environment(PlayerEngine.self) private var engine
  @ViewBuilder let pill: () -> Pill

  @State private var controlsShown = false
  @State private var hideControls: Task<Void, Never>?

  /// How long the controls stay after the last touch.
  static var controlsFor: Duration { .seconds(4) }
  /// The app icon's dark, for marks on the accent colour.
  private static var ink: Color { Color(red: 0x0E / 255, green: 0x0F / 255, blue: 0x11 / 255) }

  func body(content: Content) -> some View {
    content
      .contentShape(.rect)
      .onTapGesture { show() }
      .overlay {
        if controlsShown {
          controls.transition(.opacity)
        }
      }
      .overlay(alignment: .topTrailing) { SkipAdButton().padding(.top, 8).padding(.trailing, 8) }
      .overlay(alignment: .bottom) { pill().frame(maxWidth: 520).padding(.bottom, 14) }
      .animation(.easeInOut(duration: 0.25), value: controlsShown)
      .environment(\.colorScheme, .dark)
      .persistentSystemOverlays(.hidden)
      .accessibilityElement(children: controlsShown ? .contain : .ignore)
      .onDisappear { hideControls?.cancel() }
  }

  /// Dimmed content behind a row of large round buttons. A tap on the dim area puts them away.
  private var controls: some View {
    ZStack {
      Color.black.opacity(0.55)
        .ignoresSafeArea()
        .onTapGesture { controlsShown = false }
        .accessibilityHidden(true)
      HStack(spacing: 32) {
        round("gobackward.15", size: 34, label: "Back 15 seconds") { engine.skip(by: -15_000) }
        round(engine.playing ? "pause.fill" : "play.fill", size: 44, diameter: 96, label: engine.playing ? "Pause" : "Play") {
          engine.toggle()
        }
        round("goforward.30", size: 34, label: "Forward 30 seconds") { engine.skip(by: 30_000) }
        Button {
          show()
          Task { await model.snip() }
        } label: {
          Image(systemName: "scissors")
            .font(.system(size: 30, weight: .semibold))
            .foregroundStyle(Self.ink)
            .frame(width: 76, height: 76)
            .background(Color.accentColor, in: .circle)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Snip")
      }
    }
  }

  private func round(_ symbol: String, size: CGFloat, diameter: CGFloat = 76, label: String, action: @escaping () -> Void)
    -> some View
  {
    Button {
      show()
      action()
    } label: {
      Image(systemName: symbol)
        .font(.system(size: size, weight: .semibold))
        .foregroundStyle(.white)
        .frame(width: diameter, height: diameter)
        .background(Color(white: 0.2), in: .circle)
    }
    .buttonStyle(.plain)
    .accessibilityLabel(label)
  }

  /// Show the controls, and put them away again after a few seconds without a touch.
  private func show() {
    controlsShown = true
    hideControls?.cancel()
    hideControls = Task {
      try? await Task.sleep(for: Self.controlsFor)
      if !Task.isCancelled { controlsShown = false }
    }
  }
}

extension View {
  /// The read-along screen's tap-for-controls overlay, with the snip bar at the foot.
  func sidewaysControls<Pill: View>(@ViewBuilder pill: @escaping () -> Pill) -> some View {
    modifier(SidewaysControls(pill: pill))
  }
}
