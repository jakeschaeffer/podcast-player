import PlayerKit
import SwiftUI
import UIKit

/// The player's controls as items of the system's vertical bar: the column iOS 27.1 runs down the trailing edge of
/// the iPhone Duo's outer display and of its inner display held wide, which holds the status bar (and, elsewhere in the
/// app, the back button and the tab bar). There the column is otherwise empty under the clock, so the controls move
/// into it as separate items, one above the other: speed (Skip ad in its place during an ad break), back 15, play or
/// pause, forward 30, and Snip at the foot, nearest the thumb. The page they leave gets the room: on the outer display
/// the transcript, held wide the cover. Only applied where the system draws a vertical bar (`VerticalBar`); elsewhere
/// the controls stay in their row on the page (TransportRow).
struct BarControls: ViewModifier {
  @Environment(AppModel.self) private var model
  @Environment(PlayerEngine.self) private var engine
  let enabled: Bool

  func body(content: Content) -> some View {
    if #available(iOS 27.1, *) {
      content
        .toolbar {
          ToolbarItem(placement: .bottomBar) { speed }.axisBehavior(.verticalPreferred)
          ToolbarSpacer(.fixed, placement: .bottomBar)
          ToolbarItem(placement: .bottomBar) { skip(-15_000, "gobackward.15", "Back 15 seconds") }.axisBehavior(.verticalPreferred)
          ToolbarSpacer(.fixed, placement: .bottomBar)
          ToolbarItem(placement: .bottomBar) { play }.axisBehavior(.verticalPreferred)
          ToolbarSpacer(.fixed, placement: .bottomBar)
          ToolbarItem(placement: .bottomBar) { skip(30_000, "goforward.30", "Forward 30 seconds") }.axisBehavior(.verticalPreferred)
          ToolbarSpacer(.fixed, placement: .bottomBar)
          ToolbarItem(placement: .bottomBar) { snip.available(model.hasServer) }.axisBehavior(.verticalPreferred)
        }
        // Without a vertical bar these would make a bottom toolbar under the page's own row of controls.
        .toolbar(enabled ? .visible : .hidden, for: .bottomBar)
    } else {
      content
    }
  }

  @ViewBuilder private var speed: some View {
    if let offer = AdOffer.of(engine) {
      Button { offer.act(on: engine) } label: {
        Text(offer == .skip ? "Skip\nad" : "Undo\nskip")
          .font(.footnote.weight(.bold))
          .multilineTextAlignment(.center)
          .frame(width: 56, height: 56)
      }
    } else {
      Button { engine.cycleSpeed() } label: {
        Text(engine.speed.formatted(.number.precision(.fractionLength(0...2))) + "×")
          .font(.title3.weight(.bold).monospacedDigit())
          .minimumScaleFactor(0.6)
          .frame(width: 56, height: 56)
      }
      .accessibilityLabel("Speed \(engine.speed.formatted(.number.precision(.fractionLength(0...2))))")
    }
  }

  private func skip(_ by: Int, _ symbol: String, _ label: String) -> some View {
    Button { engine.skip(by: by) } label: {
      Image(systemName: symbol).font(.system(size: 28)).frame(width: 56, height: 56)
    }
    .accessibilityLabel(label)
  }

  private var play: some View {
    Button { engine.toggle() } label: {
      Image(systemName: engine.playing ? "pause.fill" : "play.fill")
        .font(.system(size: 32))
        .frame(width: 56, height: 64)
        .overlay {
          // Waiting for audio: say so instead of showing a pause button over silence.
          if engine.playing && engine.buffering { ProgressView().controlSize(.large) }
        }
    }
    .accessibilityLabel(engine.playing ? "Pause" : "Play")
  }

  private var snip: some View {
    Button { Task { await model.snip() } } label: {
      Image(systemName: "scissors")
        .font(.title2.weight(.semibold))
        .foregroundStyle(TransportRow.ink)
        .frame(width: 60, height: 60)
        .background(Color.accentColor, in: .circle)
    }
    .accessibilityLabel("Snip")
    .sensoryFeedback(.impact, trigger: model.snipCard.map(ObjectIdentifier.init))
  }
}

/// Whether the system draws its vertical bar where this view is (iOS 27.1's `verticalBarEdge` trait: the iPhone Duo
/// closed, and open held wide). Reported through `present`; always false before iOS 27.1.
struct VerticalBar: UIViewRepresentable {
  @Binding var present: Bool

  func makeUIView(context: Context) -> Probe {
    let probe = Probe()
    probe.report = { value in
      // Out of the layout pass that found it: SwiftUI state can't change while it lays out.
      Task { @MainActor in if present != value { present = value } }
    }
    return probe
  }

  func updateUIView(_ uiView: Probe, context: Context) {}

  final class Probe: UIView {
    var report: (Bool) -> Void = { _ in }

    override func layoutSubviews() {
      super.layoutSubviews()
      check()
    }

    override func didMoveToWindow() {
      super.didMoveToWindow()
      check()
    }

    private func check() {
      guard #available(iOS 27.1, *) else { return report(false) }
      report(traitCollection.verticalBarEdge != .unspecified)
    }
  }
}
