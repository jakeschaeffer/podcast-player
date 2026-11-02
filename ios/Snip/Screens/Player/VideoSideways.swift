import PlayerKit
import SwiftUI

/// A video turned sideways: the picture as large as the screen allows on black, with the player's own controls laid
/// over its foot (Scrubber, TransportRow) and the title over its head. A tap brings them up; they go by themselves a
/// few seconds after the last touch while the video plays, and stay while it is paused. Skip ad shows by itself during
/// a suspected ad, and the snip bar sits at the foot after a snip tap.
struct VideoSideways<Pill: View>: View {
  @Environment(PlayerEngine.self) private var engine
  @ViewBuilder let pill: () -> Pill

  @State private var controlsShown = true
  @State private var hideControls: Task<Void, Never>?

  /// How long the controls stay after the last touch while playing.
  static var controlsFor: Duration { .seconds(4) }

  var body: some View {
    ZStack {
      Color.black.ignoresSafeArea()
      VideoSurface(cornerRadius: 0).ignoresSafeArea()
      // The shades run to the screen's edges, under the title and the controls, so neither sits on a thin end.
      if controlsShown {
        VStack(spacing: 0) {
          shade(from: .top, height: 120)
          Spacer(minLength: 0)
          shade(from: .bottom, height: 260)
        }
        .ignoresSafeArea()
        .transition(.opacity)
      }
    }
    .contentShape(.rect)
    .onTapGesture { controlsShown ? hide() : show() }
    .overlay(alignment: .top) {
      if controlsShown, let title = engine.episode?.title {
        Text(title)
          .font(.subheadline.weight(.medium))
          .foregroundStyle(.white)
          .lineLimit(1)
          .shadow(color: .black.opacity(0.7), radius: 3)
          .padding(.horizontal, 24)
          .padding(.top, 10)
          .frame(maxWidth: .infinity)
          .transition(.opacity)
          .accessibilityHidden(true)
      }
    }
    // With the controls up, Skip ad is among them (TransportRow); with them away it shows by itself.
    .overlay(alignment: .topTrailing) {
      if !controlsShown { SkipAdButton().padding(.top, 8).padding(.trailing, 8) }
    }
    .overlay(alignment: .bottom) {
      VStack(spacing: 12) {
        pill().frame(maxWidth: 520)
        if controlsShown {
          VStack(spacing: 6) {
            Scrubber(onInteraction: show, onVideo: true)
            TransportRow(onInteraction: show, onVideo: true)
          }
          .frame(maxWidth: 640)
          .transition(.opacity)
        }
      }
      .padding(.horizontal, 24)
      .padding(.bottom, 10)
      .frame(maxWidth: .infinity)
    }
    .animation(.easeInOut(duration: 0.25), value: controlsShown)
    .environment(\.colorScheme, .dark)
    .persistentSystemOverlays(.hidden)
    .onAppear { show() }
    // Pausing keeps the controls up, so the position stays readable; playing on starts the clock again.
    .onChange(of: engine.playing) { _, _ in show() }
    .onDisappear { hideControls?.cancel() }
    .accessibilityLabel("Watching the video. Double-tap for the controls.")
  }

  /// A dark gradient from one edge, so what is laid over it reads on any picture; the middle of the video stays clear.
  private func shade(from edge: UnitPoint, height: CGFloat) -> some View {
    LinearGradient(
      stops: [.init(color: .black.opacity(0.85), location: 0), .init(color: .black.opacity(0.5), location: 0.55), .init(color: .clear, location: 1)],
      startPoint: edge, endPoint: edge == .top ? .bottom : .top
    )
    .frame(height: height)
    .allowsHitTesting(false)
  }

  /// Show the controls; while the video plays, put them away again a few seconds after the last touch.
  private func show() {
    controlsShown = true
    hideControls?.cancel()
    guard engine.playing else { return }
    hideControls = Task {
      try? await Task.sleep(for: Self.controlsFor)
      if !Task.isCancelled { controlsShown = false }
    }
  }

  private func hide() {
    hideControls?.cancel()
    controlsShown = false
  }
}
